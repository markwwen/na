import type { Message, ModelConfig, ModelSelection } from "../types.js";

export function selectionOf(model: ModelConfig): ModelSelection {
  return { provider: model.provider, id: model.id, thinkingLevel: model.thinkingLevel };
}

export function messagesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("baseUrl 必须是无凭据、查询参数和片段的 HTTP(S) 地址");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1/messages") ? path : path.endsWith("/v1") ? path + "/messages" : path + "/v1/messages";
  return url.toString();
}

export function requestHeaders(model: ModelConfig): Record<string, string> {
  try {
    const headers = new Headers({ "content-type": "application/json", "anthropic-version": "2023-06-01" });
    if (model.apiKey) headers.set(model.authHeader ? "authorization" : "x-api-key", model.authHeader ? `Bearer ${model.apiKey}` : model.apiKey);
    for (const [key, value] of Object.entries(model.headers)) headers.set(key, value);
    return Object.fromEntries(headers.entries());
  } catch {
    throw new Error("请求头配置无效，请检查名称和值的格式（敏感值不显示）");
  }
}

export function reasoningParameters(model: ModelConfig): Record<string, unknown> {
  if (model.thinkingLevel === "off") {
    return { thinking: { type: "disabled" }, ...(model.temperature === undefined ? {} : { temperature: model.temperature }) };
  }
  if (model.temperature !== undefined && model.temperature !== 1) throw new Error("启用 thinking 时 temperature 只能省略或为 1");
  if (model.thinkingMode === "adaptive") {
    return { thinking: { type: "adaptive" }, output_config: { effort: model.effort ?? "high" } };
  }
  const budget = Math.min(model.thinkingBudget ?? 4096, model.maxTokens - 1024);
  if (budget < 1024) throw new Error("启用 thinking 时 maxTokens 至少为 2048");
  return { thinking: { type: "enabled", budget_tokens: budget },
    ...(model.effort ? { output_config: { effort: model.effort } } : {}) };
}

// 完成轮次的 reasoning 不跨模型/强度回放；归档原文保留。
// 当前轮里的工具调用链及其签名仍完整传递。
export function replayMessages(messages: Message[]): Message[] {
  let currentStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && typeof m.content === "string") { currentStart = i; break; }
  }
  return messages.map((m, i) => {
    if (i >= currentStart || m.role !== "assistant") return m;
    const content = m.content.filter(b => b.type !== "thinking" && b.type !== "redacted_thinking");
    return { role: "assistant", content: content.length ? content : [{ type: "text", text: "[历史推理块已省略]" }] };
  });
}
