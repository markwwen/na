import { readMessageStream } from "./stream.js";

import type {
  LLMResponse,
  Message,
  ModelConfig,
  StreamEvent,
  ToolDefinition,
} from "./types.js";

export async function callLLM(
  config: ModelConfig,
  messages: Message[],
  tools: ToolDefinition[] = [],
  onEvent?: (event: StreamEvent) => void,
): Promise<LLMResponse> {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const conversation = messages.filter(
    (message) => message.role !== "system",
  );

  const response = await fetch(
    `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.id,
        system,
        messages: conversation,
        max_tokens: config.maxTokens,
        tools,

        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },

        output_config: {
          effort: "max",
        },

        stream: true,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `LLM request failed: ${response.status}\n${await response.text()}`,
    );
  }

  if (!response.body) {
    throw new Error("模型响应没有可读的流");
  }

  if (
    !response.headers
      .get("content-type")
      ?.includes("text/event-stream")
  ) {
    throw new Error("服务端没有返回 SSE，请检查网关的流式支持");
  }

  return readMessageStream(response.body, onEvent);
}