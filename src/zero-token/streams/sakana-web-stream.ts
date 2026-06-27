import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
  type ThinkingContent,
} from "@mariozechner/pi-ai";
import { v7 as uuidv7 } from "uuid";
import {
  SakanaWebClientBrowser,
  type SakanaWebClientOptions,
} from "../providers/sakana-web-client-browser.js";
import { withRetry } from "../utils/retry.js";

export function createSakanaWebStreamFn(cookieOrJson: string): StreamFn {
  let options: SakanaWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    options = parsed;
  } catch {
    options = { cookie: cookieOrJson, userAgent: "Mozilla/5.0" };
  }
  const client = new SakanaWebClientBrowser(options);

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        const messages = context.messages || [];

        // Build prompt based on conversation state
        let prompt = "";
        const lastUserMessage = [...messages].toReversed().find((m) => m.role === "user");

        if (messages.length <= 1 && lastUserMessage) {
          prompt = typeof lastUserMessage.content === "string" ? lastUserMessage.content : "";
        } else {
          // Format full history
          prompt = messages
            .map((m) => {
              const role = m.role === "user" ? "User" : "Assistant";
              const content = typeof m.content === "string" ? m.content : "";
              return `${role}: ${content}`;
            })
            .join("\n\n") + "\n\nAssistant:";
        }

        if (!prompt) {
          throw new Error("No message found to send to Sakana Chat API");
        }

        console.log(`[SakanaWebStream] Sending prompt length: ${prompt.length}`);

        const enableThinking = model.id === "namazu-thinking";

        const responseStream = await withRetry(
          () =>
            client.chatCompletions({
              message: prompt,
              model: model.id,
              enableThinking,
              userMessageId: uuidv7(),
              signal: streamOptions?.signal,
            }),
          { label: "Sakana" }
        );

        if (!responseStream) {
          throw new Error("SakanaWeb API returned empty response body");
        }

        const reader = responseStream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const indexMap = new Map<string, number>();
        let nextIndex = 0;
        const contentParts: (TextContent | ThinkingContent)[] = [];

        const createPartial = (): AssistantMessage => {
          return {
            role: "assistant",
            content: [...contentParts],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          };
        };

        let currentMode: "initial" | "thinking" | "text" = "initial";
        let tagBuffer = "";

        const emitDelta = (type: "text" | "thinking", delta: string) => {
          if (delta === "") return;

          if (!indexMap.has(type)) {
            const index = nextIndex++;
            indexMap.set(type, index);
            if (type === "text") {
              contentParts[index] = { type: "text", text: "" };
              stream.push({ type: "text_start", contentIndex: index, partial: createPartial() });
            } else if (type === "thinking") {
              contentParts[index] = { type: "thinking", thinking: "" };
              stream.push({ type: "thinking_start", contentIndex: index, partial: createPartial() });
            }
          }

          const index = indexMap.get(type)!;
          if (type === "text") {
            (contentParts[index] as TextContent).text += delta;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "thinking") {
            (contentParts[index] as ThinkingContent).thinking += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          }
        };

        const pushDelta = (delta: string) => {
          if (!delta) return;

          // Strip null bytes
          const cleanDelta = delta.replace(/\u0000/g, "");
          tagBuffer += cleanDelta;

          const checkTags = () => {
            const planStart = tagBuffer.match(/<plan\b[^<>]*>/i);
            const planEnd = tagBuffer.match(/<\/plan\b[^<>]*>/i);
            const answerStart = tagBuffer.match(/<answer\b[^<>]*>/i);
            const answerEnd = tagBuffer.match(/<\/answer\b[^<>]*>/i);

            const indices = [
              { type: "plan_start", idx: planStart?.index ?? -1, len: planStart?.[0].length ?? 0 },
              { type: "plan_end", idx: planEnd?.index ?? -1, len: planEnd?.[0].length ?? 0 },
              { type: "answer_start", idx: answerStart?.index ?? -1, len: answerStart?.[0].length ?? 0 },
              { type: "answer_end", idx: answerEnd?.index ?? -1, len: answerEnd?.[0].length ?? 0 },
            ]
              .filter((t) => t.idx !== -1)
              .sort((a, b) => a.idx - b.idx);

            if (indices.length > 0) {
              const first = indices[0];
              const before = tagBuffer.slice(0, first.idx);

              if (before) {
                const type = currentMode === "thinking" ? "thinking" : "text";
                emitDelta(type, before);
              }

              if (first.type === "plan_start") {
                currentMode = "thinking";
              } else if (first.type === "plan_end" || first.type === "answer_start") {
                currentMode = "text";
              } else if (first.type === "answer_end") {
                currentMode = "text";
              }

              tagBuffer = tagBuffer.slice(first.idx + first.len);
              checkTags();
            } else {
              // Check for partial tag at the end
              const lastAngle = tagBuffer.lastIndexOf("<");
              if (lastAngle === -1) {
                if (currentMode === "initial") {
                  currentMode = "text";
                }
                const type = (currentMode as string) === "thinking" ? "thinking" : "text";
                emitDelta(type, tagBuffer);
                tagBuffer = "";
              } else {
                const suffix = tagBuffer.slice(lastAngle);
                if (suffix.length > 12) {
                  // Not a partial tag since it is too long without matching any tag. Emit everything.
                  if (currentMode === "initial") {
                    currentMode = "text";
                  }
                  const type = (currentMode as string) === "thinking" ? "thinking" : "text";
                  emitDelta(type, tagBuffer);
                  tagBuffer = "";
                } else {
                  const before = tagBuffer.slice(0, lastAngle);
                  if (before) {
                    if (currentMode === "initial") {
                      currentMode = "text";
                    }
                    const type = (currentMode as string) === "thinking" ? "thinking" : "text";
                    emitDelta(type, before);
                  }
                  tagBuffer = suffix;
                }
              }
            }
          };
          checkTags();
        };

        const processLine = (line: string) => {
          if (!line) return;
          const trimmed = line.trim();
          if (!trimmed) return;

          try {
            const data = JSON.parse(trimmed);
            if (data.type === "stream" && data.token) {
              pushDelta(data.token);
            }
          } catch {
            // ignore malformed NDJSON lines
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              processLine(buffer.trim());
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const combined = buffer + chunk;
          const parts = combined.split("\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            processLine(part);
          }
        }

        // Flush any remaining tag buffer
        if (tagBuffer) {
          if (currentMode === "initial") {
            currentMode = "text";
          }
          const type = (currentMode as string) === "thinking" ? "thinking" : "text";
          emitDelta(type, tagBuffer);
        }

        console.log(`[SakanaWebStream] Stream completed successfully`);

        stream.push({
          type: "done",
          reason: "stop",
          message: createPartial(),
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        } as any);
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
