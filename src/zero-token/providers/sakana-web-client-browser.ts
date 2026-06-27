import { chromium, type BrowserContext, type Page } from "playwright-core";
import { getSharedBrowser, releaseSharedBrowser } from "./shared-browser.js";
import type { ModelDefinitionConfig } from "../types.js";

export interface SakanaWebClientOptions {
  cookie: string;
  userAgent: string;
}

export class SakanaWebClientBrowser {
  private cookie: string;
  private userAgent: string;
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private initialized = false;

  constructor(options: SakanaWebClientOptions | string) {
    if (typeof options === "string") {
      const parsed = JSON.parse(options) as SakanaWebClientOptions;
      this.cookie = parsed.cookie;
      this.userAgent = parsed.userAgent;
    } else {
      this.cookie = options.cookie;
      this.userAgent = options.userAgent;
    }
  }

  private parseCookies(): Array<{ name: string; value: string; domain: string; path: string }> {
    return this.cookie
      .split(";")
      .filter((c) => c.trim().includes("="))
      .map((cookie) => {
        const [name, ...valueParts] = cookie.trim().split("=");
        return {
          name: name?.trim() ?? "",
          value: valueParts.join("=").trim(),
          domain: ".sakana.ai",
          path: "/",
        };
      })
      .filter((c) => c.name.length > 0);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const { context, page, isNew } = await getSharedBrowser("Sakana Web Browser", "https://chat.sakana.ai/");
    this.browser = context;
    this.page = page;

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      try {
        await this.browser.addCookies(cookies);
        if (isNew) {
          await this.page.reload({ waitUntil: "domcontentloaded" });
        }
      } catch (e) {
        console.warn("[Sakana Web Browser] Failed to add cookies:", e);
      }
    }

    const pageUrl = this.page.url();
    if (!pageUrl.includes("chat.sakana.ai")) {
      console.log(`[Sakana Web Browser] Page not on chat.sakana.ai (${pageUrl}), navigating...`);
      await this.page.goto("https://chat.sakana.ai/", { waitUntil: "domcontentloaded" });
    }

    // Add page console and error logging for debugging
    this.page.on("console", (msg) => {
      console.log(`[Sakana Page Console] ${msg.type()}: ${msg.text()}`);
    });
    this.page.on("pageerror", (err) => {
      console.error(`[Sakana Page Error] ${err.message}`);
    });

    this.initialized = true;
  }

  async chatCompletions(params: {
    message: string;
    model: string;
    enableThinking: boolean;
    userMessageId: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) {
      throw new Error("SakanaWebClientBrowser not initialized");
    }

    const { message, model, enableThinking, userMessageId } = params;

    const currentUrl = this.page.url();
    if (!currentUrl.includes("chat.sakana.ai")) {
      console.log(`[Sakana Web Browser] Page on wrong domain (${currentUrl}), navigating...`);
      await this.page.goto("https://chat.sakana.ai/", { waitUntil: "domcontentloaded" });
    }

    console.log(`[Sakana Web Browser] Sending chatCompletion: model=${model}, enableThinking=${enableThinking}`);

    const responseData = await this.page.evaluate(
      async ({ message, enableThinking, userMessageId }) => {
        try {
          // Step 1: Create conversation
          const createRes = await fetch("https://chat.sakana.ai/conversation", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              inputs: message,
              enableThinking: enableThinking,
              toneMode: "default",
              webSearchEnabled: true,
              agentId: "namazu",
            }),
          });

          if (!createRes.ok) {
            return {
              ok: false,
              status: createRes.status,
              data: `Failed to create Sakana conversation: ${createRes.status} ${createRes.statusText}`,
              conversationId: "",
            };
          }

          const createData = await createRes.json();
          const { conversationId, systemMessageId } = createData;

          if (!conversationId || !systemMessageId) {
            return {
              ok: false,
              status: 500,
              data: `Invalid conversation creation response: ${JSON.stringify(createData)}`,
              conversationId: "",
            };
          }

          // Step 2: Request the stream
          const formData = new FormData();
          formData.append(
            "data",
            JSON.stringify({
              inputs: message,
              id: systemMessageId,
              is_retry: false,
              is_continue: false,
              enableThinking: enableThinking,
              toneMode: "default",
              webSearchEnabled: true,
              userMessageId: userMessageId,
            })
          );

          const streamRes = await fetch(`https://chat.sakana.ai/conversation/${conversationId}`, {
            method: "POST",
            body: formData,
          });

          if (!streamRes.ok) {
            return {
              ok: false,
              status: streamRes.status,
              data: `Sakana stream request failed: ${streamRes.status} ${streamRes.statusText}`,
              conversationId,
            };
          }

          const reader = streamRes.body?.getReader();
          if (!reader) {
            return {
              ok: false,
              status: 500,
              data: "Sakana response body is not readable",
              conversationId,
            };
          }

          const decoder = new TextDecoder();
          let fullText = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            fullText += decoder.decode(value, { stream: true });
          }

          return { ok: true, status: 200, data: fullText, conversationId };
        } catch (e: any) {
          return {
            ok: false,
            status: e.status || 500,
            data: e instanceof Error ? e.message : String(e),
            conversationId: "",
          };
        }
      },
      { message, enableThinking, userMessageId }
    );

    if (!responseData.ok) {
      const status = (responseData as any).status;
      if (status === 401 || status === 403) {
        throw new Error(
          `Authentication failed (status ${status}). Please re-run onboarding ('npm run login -- --provider sakana-web') to refresh your Sakana Chat session.`
        );
      }
      throw new Error(`Sakana Web Client Error: ${responseData.data}`);
    }

    console.log(`[Sakana Web Browser] Stream returned successfully. Size: ${responseData.data.length} bytes`);

    // Convert the fullText response to a ReadableStream
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(responseData.data));
        controller.close();
      },
    });
  }

  async close(): Promise<void> {
    await releaseSharedBrowser();
    this.browser = null;
    this.page = null;
    this.initialized = false;
  }

  async discoverModels(): Promise<ModelDefinitionConfig[]> {
    return [
      {
        id: "namazu",
        name: "Namazu",
        api: "sakana-web",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
      {
        id: "namazu-thinking",
        name: "Namazu (Reasoning)",
        api: "sakana-web",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ];
  }
}
