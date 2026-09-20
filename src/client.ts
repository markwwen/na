import type {
  AssistantMessage,
  LLMResponse,
  Message,
  ModelConfig,
  ToolDefinition,
} from "./types.js";

export async function callLLM(
  config: ModelConfig,
  messages: Message[],
  tools: ToolDefinition[] = [],
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
        stream: false,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `LLM request failed: ${response.status}\n${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    content: AssistantMessage["content"];
    stop_reason: string | null;
  };

  if (!Array.isArray(data.content)) {
    throw new Error("模型响应缺少 content 数组");
  }

  // 本版仅支持文本和客户端工具调用，遇到其他内容块明确报错。
  for (const block of data.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      continue;
    }

    if (
      block?.type === "tool_use" &&
      typeof block.id === "string" &&
      block.id.length > 0 &&
      typeof block.name === "string" &&
      "input" in block
    ) {
      continue;
    }

    throw new Error("模型返回了不支持或格式错误的内容块");
  }

  return {
    message: {
      role: "assistant",
      content: data.content,
    },
    stopReason: data.stop_reason,
  };
}