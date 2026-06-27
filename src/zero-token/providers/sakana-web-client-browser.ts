import type { BrowserContext, Page } from "playwright-core";
import { getSharedBrowser, releaseSharedBrowser } from "./shared-browser.js";
import type { ModelDefinitionConfig } from "../types.js";

export interface SakanaWebClientOptions {
  cookie: string;
  userAgent: string;
}

type SakanaStreamBridgeEvent = {
  channel: string;
  type: "chunk" | "done" | "error" | "metadata";
  data?: string;
};

type SakanaStreamChannel = {
  enqueue: (chunk: string) => void;
  close: () => void;
  error: (message: string) => void;
  metadata?: (json: string) => void;
};

const SAKANA_STREAM_BRIDGE_NAME = "__zerotokenSakanaStreamBridge";
const sakanaStreamChannels = new Map<string, SakanaStreamChannel>();
const sakanaBridgePages = new WeakSet<Page>();
// Module-level conversation store — persists across all client instances
const globalConversationMap = new Map<string, { conversationId: string; systemMessageId: string }>();

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
      } else if (event.type === "metadata" && channel.metadata) {
        channel.metadata(event.data || "");
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
    topicId?: string;
    newTopic?: boolean;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) {
      throw new Error("SakanaWebClientBrowser not initialized");
    }

    const { message, model, enableThinking, userMessageId, topicId, newTopic } = params;
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

    // NEW: Conversation reuse logic
    const effectiveTopicId = topicId ?? "default";
    let conversationState = newTopic ? null : globalConversationMap.get(effectiveTopicId);
    let needsCreate = !conversationState;

    const encoder = new TextEncoder();
    let abortBrowserFetch: (() => void) | null = null;
    let cleanup: (() => void) | null = null;
    // Capture `this` for use inside ReadableStream callbacks
    const self = this;

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
          metadata: (jsonStr) => {
            try {
              const meta = JSON.parse(jsonStr);
              if (meta.systemMessageId && conversationState) {
                conversationState.systemMessageId = meta.systemMessageId;
                globalConversationMap.set(effectiveTopicId, conversationState);
                console.log(`[Sakana Web Browser] Updated systemMessageId: ${meta.systemMessageId}`);
              }
            } catch {}
          },
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

        // NEW: If we need to create a conversation, do it first
        if (needsCreate) {
          try {
            const createResult = await page.evaluate(
              async (opts: {
                message: string;
                model: string;
                enableThinking: boolean;
                agentId: string;
              }) => {
                // Try v2 API first, fall back to v1
                const body = JSON.stringify({
                  messages: [
                    { role: "user", content: opts.message }
                  ],
                  model: opts.agentId,
                  enableThinking: opts.enableThinking,
                  toneMode: "default",
                });
                const res = await fetch("https://chat.sakana.ai/api/v2/conversations", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body,
                });
                if (res.ok) {
                  const data = await res.json();
                  // v2 API might use different field names
                  const convId = data.conversationId || data.conversation_id || data.id || data.threadId;
                  const sysMsgId = data.systemMessageId || data.system_message_id || data.messageId;
                  if (convId) {
                    return { conversationId: convId, systemMessageId: sysMsgId || convId };
                  }
                }
                // Fallback to v1 API
                const v1Res = await fetch("https://chat.sakana.ai/conversation", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    inputs: opts.message,
                    enableThinking: opts.enableThinking,
                    toneMode: "default",
                    webSearchEnabled: !opts.enableThinking,
                    agentId: opts.agentId,
                  }),
                });
                if (!v1Res.ok) throw new Error(`Create conversation failed: ${v1Res.status}`);
                const v1Data = await v1Res.json();
                return { conversationId: v1Data.conversationId, systemMessageId: v1Data.systemMessageId };
              },
              { message, model, enableThinking, agentId }
            );

            if (!createResult?.conversationId) {
              errorOnce("Failed to create Sakana conversation");
              return;
            }

            conversationState = createResult;
            globalConversationMap.set(effectiveTopicId, conversationState);
            console.log(`[Sakana Web Browser] Created conversation: ${createResult.conversationId}`);
          } catch (e: any) {
            errorOnce(`Failed to create conversation: ${e.message}`);
            return;
          }
        }

        const existingConversationId = conversationState!.conversationId;
        const existingSystemMessageId = conversationState!.systemMessageId;
        const isContinue = !needsCreate; // true when reusing existing conversation

        void page.evaluate(
          async ({
            message,
            conversationId,
            systemMessageId,
            userMessageId,
            isContinue,
            enableThinking,
            webSearchEnabled,
            agentId,
            channel,
            bridgeName,
            abortName,
          }: {
            message: string;
            conversationId: string;
            systemMessageId: string;
            userMessageId: string;
            isContinue: boolean;
            enableThinking: boolean;
            webSearchEnabled: boolean;
            agentId: string;
            channel: string;
            bridgeName: string;
            abortName: string;
          }) => {
            const emit = async (type: "chunk" | "done" | "error" | "metadata", data?: string) => {
              const bridge = (globalThis as any)[bridgeName];
              if (typeof bridge === "function") {
                await bridge({ channel, type, data });
              }
            };

            const abortController = new AbortController();
            (globalThis as any)[abortName] = () => abortController.abort();

            try {
              // Send message to existing conversation (no create needed)
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
              let streamBuffer = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  const tail = decoder.decode();
                  if (tail) {
                    streamBuffer += tail;
                  }
                  // Flush remaining buffer — check for IDs
                  if (streamBuffer) {
                    const lines = streamBuffer.split("\n");
                    for (const line of lines) {
                      const trimmed = line.trim();
                      if (!trimmed) continue;
                      try {
                        const parsed = JSON.parse(trimmed);
                        if (parsed.token) {
                          await emit("chunk", line + "\n");
                        }
                        // Capture updated systemMessageId from stream
                        if (parsed.id && typeof parsed.id === "string") {
                          await emit("metadata", JSON.stringify({ systemMessageId: parsed.id }));
                        }
                      } catch {
                        await emit("chunk", line + "\n");
                      }
                    }
                  }
                  break;
                }
                const chunk = decoder.decode(value, { stream: true });
                streamBuffer += chunk;
                const parts = streamBuffer.split("\n");
                streamBuffer = parts.pop() || "";
                for (const part of parts) {
                  const trimmed = part.trim();
                  if (!trimmed) continue;
                  try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed.token) {
                      await emit("chunk", part + "\n");
                    }
                    // Capture updated systemMessageId from stream
                    if (parsed.id && typeof parsed.id === "string") {
                      await emit("metadata", JSON.stringify({ systemMessageId: parsed.id }));
                    }
                  } catch {
                    await emit("chunk", part + "\n");
                  }
                }
              }

              // --- Phase 2: Reliable cursor tracking + tree finalization ---
              // Step A: Fetch conversation data to reliably get the last assistant message ID
              // (The NDJSON stream may not include an `id` field, so this is our fallback)
              let leafId: string | null = null;
              try {
                const convRes = await fetch(
                  `https://chat.sakana.ai/api/v2/conversations/${conversationId}`,
                );
                if (convRes.ok) {
                  const convData = await convRes.json();
                  // Try multiple possible response shapes for the message tree
                  if (convData.messages && Array.isArray(convData.messages)) {
                    // Flat array — last message is the leaf
                    const lastMsg = convData.messages[convData.messages.length - 1];
                    if (lastMsg?.id) leafId = lastMsg.id;
                  }
                  // Try tree-based structure
                  if (!leafId && convData.rootMessage) {
                    // Walk the tree to find the leaf
                    let node = convData.rootMessage;
                    while (node.children && node.children.length > 0) {
                      node = node.children[node.children.length - 1];
                    }
                    if (node.id) leafId = node.id;
                  }
                  // Try direct fields
                  if (!leafId) {
                    leafId = convData.lastMessageId || convData.leafMessageId || null;
                  }
                  if (leafId) {
                    await emit("metadata", JSON.stringify({ systemMessageId: leafId }));
                  }
                }
              } catch {
                // Non-fatal — cursor just won't update via this path
              }

              // Step B: Call /compact to finalize the conversation tree
              // This is what makes follow-up messages visible in the Sakana Chat Web UI
              if (leafId) {
                try {
                  await fetch(
                    `https://chat.sakana.ai/conversation/${conversationId}/compact`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ leafMessageId: leafId }),
                    },
                  );
                } catch {
                  // Non-fatal — Web UI visibility may be affected but API still works
                }
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
            conversationId: existingConversationId,
            systemMessageId: existingSystemMessageId,
            userMessageId,
            isContinue,
            enableThinking,
            webSearchEnabled,
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
