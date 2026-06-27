import { type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { AssistantMessage } from "@mariozechner/pi-ai";

export interface OpenAICompatDelta {
  role?: "assistant";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: {
    index: number;
    id?: string;
    type?: "function";
    function: {
      name?: string;
      arguments?: string;
    };
  }[];
}

export function formatSSEChunk(
  chunkId: string,
  model: string,
  delta: OpenAICompatDelta,
  finishReason: string | null = null
): string {
  const payload = {
    id: chunkId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function pipeStreamToResponse(
  stream: any, // AssistantMessageEventStream
  model: string,
  res: Response
): Promise<void> {
  const chunkId = `chatcmpl-${uuidv4().replace(/-/g, "")}`;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Keep track of tool index mappings (contentIndex -> toolIndex)
  const toolIndexMap = new Map<number, number>();
  let nextToolIndex = 0;

  try {
    for await (const event of stream) {
      if (event.type === "start") {
        // Send initial chunk
        res.write(formatSSEChunk(chunkId, model, { role: "assistant", content: "" }));
      } else if (event.type === "text_delta") {
        res.write(formatSSEChunk(chunkId, model, { content: event.delta }));
      } else if (event.type === "thinking_delta") {
        res.write(formatSSEChunk(chunkId, model, { reasoning_content: event.delta }));
      } else if (event.type === "toolcall_start") {
        const contentIndex = event.contentIndex;
        const partialPart = event.partial?.content?.[contentIndex];
        if (partialPart && partialPart.type === "toolCall") {
          const toolIndex = nextToolIndex++;
          toolIndexMap.set(contentIndex, toolIndex);
          res.write(
            formatSSEChunk(chunkId, model, {
              tool_calls: [
                {
                  index: toolIndex,
                  id: partialPart.id,
                  type: "function",
                  function: {
                    name: partialPart.name,
                    arguments: "",
                  },
                },
              ],
            })
          );
        }
      } else if (event.type === "toolcall_delta") {
        const contentIndex = event.contentIndex;
        const toolIndex = toolIndexMap.get(contentIndex);
        if (toolIndex !== undefined) {
          res.write(
            formatSSEChunk(chunkId, model, {
              tool_calls: [
                {
                  index: toolIndex,
                  function: {
                    arguments: event.delta,
                  },
                },
              ],
            })
          );
        }
      } else if (event.type === "done") {
        const msg = event.message as AssistantMessage;
        const finishReason = msg.stopReason === "toolUse" ? "tool_calls" : "stop";
        res.write(formatSSEChunk(chunkId, model, {}, finishReason));
        res.write("data: [DONE]\n\n");
      } else if (event.type === "error") {
        const err = event.error || {};
        res.write(`data: ${JSON.stringify({ error: { message: err.errorMessage || "Unknown stream error" } })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
    }
  } catch (error) {
    console.error("Stream pipe error:", error);
    res.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } })}\n\n`);
    res.write("data: [DONE]\n\n");
  } finally {
    res.end();
  }
}

export async function accumulateStreamToJSON(
  stream: any,
  model: string
): Promise<any> {
  const chunkId = `chatcmpl-${uuidv4().replace(/-/g, "")}`;
  let content = "";
  let reasoningContent = "";
  const toolCalls: any[] = [];
  const contentIndexToToolMap = new Map<number, any>();
  let finishReason = "stop";

  try {
    for await (const event of stream) {
      if (event.type === "text_delta") {
        content += event.delta;
      } else if (event.type === "thinking_delta") {
        reasoningContent += event.delta;
      } else if (event.type === "toolcall_start") {
        const contentIndex = event.contentIndex;
        const partialPart = event.partial?.content?.[contentIndex];
        if (partialPart && partialPart.type === "toolCall") {
          const toolCall = {
            id: partialPart.id,
            type: "function",
            function: {
              name: partialPart.name,
              arguments: "",
            },
          };
          contentIndexToToolMap.set(contentIndex, toolCall);
          toolCalls.push(toolCall);
        }
      } else if (event.type === "toolcall_delta") {
        const contentIndex = event.contentIndex;
        const toolCall = contentIndexToToolMap.get(contentIndex);
        if (toolCall) {
          toolCall.function.arguments += event.delta;
        }
      } else if (event.type === "done") {
        const msg = event.message as AssistantMessage;
        finishReason = msg.stopReason === "toolUse" ? "tool_calls" : "stop";
      } else if (event.type === "error") {
        throw new Error(event.error?.errorMessage || "Unknown stream error");
      }
    }

    const message: any = {
      role: "assistant",
      content: content || null,
    };

    if (reasoningContent) {
      message.reasoning_content = reasoningContent;
    }

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    return {
      id: chunkId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  } catch (error) {
    console.error("Stream accumulation error:", error);
    throw error;
  }
}
