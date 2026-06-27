import type { BrowserContext, Page } from "playwright-core";
import { getSharedBrowser, releaseSharedBrowser } from "./shared-browser.js";
import type { ModelDefinitionConfig } from "../types.js";

export interface SakanaWebClientOptions {
  cookie: string;
  userAgent: string;
}

type SakanaStreamBridgeEvent = {
  channel: string;
  type: "chunk" | "done" | "error";
  data?: string;
};

type SakanaStreamChannel = {
  enqueue: (chunk: string) => void;
  close: () => void;
  error: (message: string) => void;
};

const SAKANA_STREAM_BRIDGE_NAME = "__zerotokenSakanaStreamBridge";
const sakanaStreamChannels = new Map<string, SakanaStreamChannel>();
const sakanaBridgePages = new WeakSet<Page>();

async function ensureSakanaStreamBridge(page: Page): Promise<void> {
  if (sakanaBridgePages.has(page)) {
    return;
  }

  try {
    await page.exposeFunction(SAKANA_STREAM_BRIDGE_NAME, (event: SakanaStreamBridgeEvent) => {
      const channel = sakanaStreamChannels.get(event.channel);
      if (!channel) {
        return;
      }

      if (event.type === "chunk") {
        channel.enqueue(event.data || "");
      } else if (event.type === "done") {
        channel.close();
      } else if (event.type === "error") {
        channel.error(event.data || "Sakana stream failed");
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("has been already registered")) {
      throw error;
    }
  }

  sakanaBridgePages.add(page);
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
    const page = this.page;

    const currentUrl = page.url();
    if (!currentUrl.includes("chat.sakana.ai")) {
      console.log(`[Sakana Web Browser] Page on wrong domain (${currentUrl}), navigating...`);
      await page.goto("https://chat.sakana.ai/", { waitUntil: "domcontentloaded" });
    }

    console.log(`[Sakana Web Browser] Sending chatCompletion: model=${model}, enableThinking=${enableThinking}`);

    await ensureSakanaStreamBridge(page);

    const channel = `sakana_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const abortName = `__zerotokenSakanaAbort_${channel}`;
    const agentId = model.includes("fugu")
      ? "fugu"
      : model.includes("osaka")
        ? "osaka"
        : "namazu";
    const webSearchEnabled = !enableThinking;

    const encoder = new TextEncoder();
    let abortBrowserFetch: (() => void) | null = null;
    let cleanup: (() => void) | null = null;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        let settled = false;

        const closeOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup?.();
          controller.close();
        };

        const errorOnce = (message: string) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup?.();
          controller.error(new Error(message));
        };

        const abortHandler = () => {
          abortBrowserFetch?.();
          errorOnce("Sakana request aborted");
        };

        cleanup = () => {
          sakanaStreamChannels.delete(channel);
          params.signal?.removeEventListener("abort", abortHandler);
          void page.evaluate((name) => {
            delete (globalThis as any)[name];
          }, abortName).catch(() => {});
        };

        sakanaStreamChannels.set(channel, {
          enqueue: (chunk) => {
            if (!settled && chunk) {
              controller.enqueue(encoder.encode(chunk));
            }
          },
          close: closeOnce,
          error: errorOnce,
        });

        abortBrowserFetch = () => {
          void page.evaluate((name) => {
            const abort = (globalThis as any)[name];
            if (typeof abort === "function") {
              abort();
            }
          }, abortName).catch(() => {});
        };

        if (params.signal?.aborted) {
          abortHandler();
          return;
        }
        params.signal?.addEventListener("abort", abortHandler, { once: true });

        void page.evaluate(
          async ({
            message,
            enableThinking,
            webSearchEnabled,
            userMessageId,
            agentId,
            channel,
            bridgeName,
            abortName,
          }) => {
            const emit = async (type: "chunk" | "done" | "error", data?: string) => {
              const bridge = (globalThis as any)[bridgeName];
              if (typeof bridge === "function") {
                await bridge({ channel, type, data });
              }
            };

            const abortController = new AbortController();
            (globalThis as any)[abortName] = () => abortController.abort();

            try {
              // Step 1: Create conversation
              const createRes = await fetch("https://chat.sakana.ai/conversation", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                signal: abortController.signal,
                body: JSON.stringify({
                  inputs: message,
                  enableThinking,
                  toneMode: "default",
                  webSearchEnabled,
                  agentId,
                }),
              });

              if (!createRes.ok) {
                await emit(
                  "error",
                  `Failed to create Sakana conversation: ${createRes.status} ${createRes.statusText}`,
                );
                return;
              }

              const createData = await createRes.json();
              const { conversationId, systemMessageId } = createData;

              if (!conversationId || !systemMessageId) {
                await emit(
                  "error",
                  `Invalid conversation creation response: ${JSON.stringify(createData)}`,
                );
                return;
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
                  enableThinking,
                  toneMode: "default",
                  webSearchEnabled,
                  userMessageId,
                }),
              );

              const streamRes = await fetch(`https://chat.sakana.ai/conversation/${conversationId}`, {
                method: "POST",
                body: formData,
                signal: abortController.signal,
              });

              if (!streamRes.ok) {
                await emit(
                  "error",
                  `Sakana stream request failed: ${streamRes.status} ${streamRes.statusText}`,
                );
                return;
              }

              const reader = streamRes.body?.getReader();
              if (!reader) {
                await emit("error", "Sakana response body is not readable");
                return;
              }

              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  const tail = decoder.decode();
                  if (tail) {
                    await emit("chunk", tail);
                  }
                  break;
                }
                await emit("chunk", decoder.decode(value, { stream: true }));
              }

              await emit("done");
            } catch (e: any) {
              if (e?.name === "AbortError") {
                await emit("error", "Sakana request aborted");
                return;
              }
              await emit("error", e instanceof Error ? e.message : String(e));
            } finally {
              delete (globalThis as any)[abortName];
            }
          },
          {
            message,
            enableThinking,
            webSearchEnabled,
            userMessageId,
            agentId,
            channel,
            bridgeName: SAKANA_STREAM_BRIDGE_NAME,
            abortName,
          },
        ).catch((error) => {
          errorOnce(error instanceof Error ? error.message : String(error));
        });
      },
      cancel() {
        abortBrowserFetch?.();
        cleanup?.();
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
      {
        id: "fugu",
        name: "Fugu",
        api: "sakana-web",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
      {
        id: "fugu-thinking",
        name: "Fugu (Reasoning)",
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
