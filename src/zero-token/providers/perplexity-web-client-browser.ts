import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getHeadersWithAuth } from "./browser-cdp.js";
import { getChromeWebSocketUrl, launchOpenClawChrome } from "./browser-chrome.js";
import { resolveZeroTokenBrowserRuntime } from "./browser-runtime.js";
import { getSharedBrowser, releaseSharedBrowser } from "./shared-browser.js";
import type { ModelDefinitionConfig } from "../types.js";

export interface PerplexityWebClientOptions {
  cookie: string;
  userAgent?: string;
}

const PERPLEXITY_BASE_URL = "https://www.perplexity.ai";

export class PerplexityWebClientBrowser {
  private options: PerplexityWebClientOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialized = false;
  lastConversationId: string | undefined;

  constructor(options: PerplexityWebClientOptions | string) {
    if (typeof options === "string") {
      try {
        const parsed = JSON.parse(options) as PerplexityWebClientOptions;
        this.options = { cookie: parsed.cookie, userAgent: parsed.userAgent };
      } catch {
        this.options = { cookie: options, userAgent: "Mozilla/5.0" };
      }
    } else {
      this.options = options;
    }
  }

  private parseCookies(): Array<{ name: string; value: string; domain: string; path: string }> {
    return this.options.cookie
      .split(";")
      .filter((c) => c.trim().includes("="))
      .map((cookie) => {
        const [name, ...valueParts] = cookie.trim().split("=");
        return {
          name: name?.trim() ?? "",
          value: valueParts.join("=").trim(),
          domain: ".perplexity.ai",
          path: "/",
        };
      })
      .filter((c) => c.name.length > 0);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const { context, page, isNew } = await getSharedBrowser("Perplexity Web Browser", PERPLEXITY_BASE_URL);
    this.context = context;
    this.page = page;

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies);
        // Reload after adding cookies so Perplexity picks up auth state
        if (isNew) {
          await this.page.reload({ waitUntil: "domcontentloaded" });
        }
      } catch (e) {
        console.warn("[Perplexity Web Browser] Failed to add some cookies:", e);
      }
    }

    // Verify page is actually on perplexity.ai domain
    const pageUrl = this.page.url();
    if (!pageUrl.includes("perplexity.ai")) {
      console.log(`[Perplexity Web Browser] Page not on perplexity.ai (${pageUrl}), navigating...`);
      await this.page.goto(PERPLEXITY_BASE_URL, { waitUntil: "domcontentloaded" });
    }

    this.initialized = true;
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) {
      throw new Error("PerplexityWebClientBrowser not initialized");
    }

    const { conversationId, message, model } = params;
    console.log(
      `[Perplexity Web Browser] Sending request... conversationId=${conversationId ?? "(new)"} messageLen=${message.length}`,
    );

    // Ensure page is on perplexity.ai before evaluate (avoid CORS failures)
    const currentUrl = this.page.url();
    if (!currentUrl.includes("perplexity.ai")) {
      console.log(`[Perplexity Web Browser] Page on wrong domain (${currentUrl}), navigating...`);
      await this.page.goto(PERPLEXITY_BASE_URL, { waitUntil: "domcontentloaded" });
    }

    const evalResult = await this.page.evaluate(
      async ({
        conversationId,
        message,
        model,
      }: {
        conversationId?: string;
        message: string;
        model: string;
      }) => {
        const MODEL_MAP_INTERNAL: Record<string, string> = {
          "perplexity-web": "sonar",
          "perplexity-pro": "sonar-pro",
        };
        const modelInternal = MODEL_MAP_INTERNAL[model] || model || "sonar";

        // Try to get conversation ID from URL if not provided
        let convId = conversationId;
        if (!convId) {
          const m = window.location.pathname.match(/\/search\/([a-zA-Z0-9_-]+)/);
          convId = m?.[1] ?? undefined;
        }
        if (!convId) {
          const m = window.location.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
          convId = m?.[1] ?? undefined;
        }

        // Call the Perplexity frontend API endpoint (body only, no query string)
        const response = await fetch("https://www.perplexity.ai/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({
            query: message,
            model: modelInternal,
            source: "default",
            mode: "copilot",
            ...(convId ? { session_id: convId } : {}),
          }),
          credentials: "include",
        });

        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 401 || response.status === 403) {
            throw new Error(
              `Perplexity 登录已过期（HTTP ${response.status}），请重新登录 www.perplexity.ai`,
            );
          }
          throw new Error(
            `Perplexity API error: ${response.status} ${response.statusText} - ${errText.slice(0, 300)}`,
          );
        }

        // Return the SSE stream as text
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const chunks: number[][] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(Array.from(value));
        }

        return { chunks, conversationId: convId };
      },
      { conversationId, message, model },
    );

    const timeoutMs = 120000;
    const result = await Promise.race([
      evalResult,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Perplexity request timed out (${timeoutMs / 1000}s). Please ensure perplexity.ai is logged in.`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Perplexity Web Browser] Error:`, msg);
      throw err;
    });

    const apiResult = result as { chunks: number[][]; conversationId?: string };
    this.lastConversationId = apiResult.conversationId ?? undefined;

    const fullBytes = apiResult.chunks.flatMap((c) => c);
    const fullText = new TextDecoder().decode(new Uint8Array(fullBytes));
    console.log(`[Perplexity Web Browser] Response length: ${fullBytes.length} bytes`);

    // Parse SSE lines and extract content
    const lines = fullText.split("\n").filter((line) => line.trim());
    const parsedChunks: string[] = [];
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        const content =
          data.text ?? data.content ?? data.delta ?? data.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content) {
          parsedChunks.push(content);
        }
      } catch {
        // Skip unparseable lines
      }
    }

    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < parsedChunks.length) {
          const line = JSON.stringify({ contentDelta: parsedChunks[index] }) + "\n";
          controller.enqueue(new TextEncoder().encode(line));
          index++;
        } else {
          controller.close();
        }
      },
    });
  }

  async close(): Promise<void> {
    await releaseSharedBrowser();
    this.page = null;
    this.context = null;
    this.browser = null;
    this.initialized = false;
  }

  async discoverModels(): Promise<ModelDefinitionConfig[]> {
    return [
      {
        id: "perplexity-web",
        name: "Perplexity (Sonar)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "perplexity-pro",
        name: "Perplexity Pro",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ];
  }
}
