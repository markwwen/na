import type { Message, ModelSelection } from "../types.js";

export interface ContextCheckpoint {
  // 摘要覆盖 messages[1..through)，不包含最初的 system。
  through: number;
  summary: string;
}

export interface SessionSnapshot {
  model?: ModelSelection;
  messages: Message[];
  context?: ContextCheckpoint;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("应为对象");
  }
  return value as Record<string, unknown>;
}

export function assertHistory(value: unknown): asserts value is Message[] {
  if (!Array.isArray(value) || !value.length) throw new Error("会话没有消息");
  const first = object(value[0]);
  if (first.role !== "system" || typeof first.content !== "string") {
    throw new Error("会话首条消息必须是 system");
  }
  let expected: "user" | "assistant" | "results" = "user";
  let pending = new Set<string>();

  for (const raw of value.slice(1)) {
    const message = object(raw);
    if (expected === "user") {
      if (message.role !== "user" || typeof message.content !== "string" || !message.content.trim()) {
        throw new Error("轮次必须以用户文本开始");
      }
      expected = "assistant";
    } else if (expected === "results") {
      if (message.role !== "user" || !Array.isArray(message.content)) throw new Error("缺少工具结果");
      for (const rawBlock of message.content) {
        const block = object(rawBlock);
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string" ||
          !pending.delete(block.tool_use_id) || typeof block.content !== "string" ||
          (block.is_error !== undefined && typeof block.is_error !== "boolean")) {
          throw new Error("工具结果与调用不匹配");
        }
      }
      if (pending.size) throw new Error("工具结果不完整");
      expected = "assistant";
    } else {
      if (message.role !== "assistant" || !Array.isArray(message.content) || !message.content.length) {
        throw new Error("缺少 assistant 消息");
      }
      pending = new Set();
      let hasText = false;
      for (const rawBlock of message.content) {
        const block = object(rawBlock);
        switch (block.type) {
          case "text":
            if (typeof block.text !== "string") throw new Error("text 无效");
            hasText ||= !!block.text.trim();
            break;
          case "thinking":
            if (typeof block.thinking !== "string" ||
              (block.signature !== undefined && typeof block.signature !== "string")) throw new Error("thinking 无效");
            break;
          case "redacted_thinking":
            if (typeof block.data !== "string") throw new Error("redacted_thinking 无效");
            break;
          case "tool_use":
            if (typeof block.id !== "string" || !block.id || pending.has(block.id) ||
              typeof block.name !== "string" || !block.name) throw new Error("tool_use 无效");
            object(block.input);
            pending.add(block.id);
            break;
          default: throw new Error(`不支持的历史内容块：${block.type}`);
        }
      }
      if (!pending.size && !hasText) throw new Error("轮次缺少最终回答");
      expected = pending.size ? "results" : "user";
    }
  }
  if (expected !== "user") throw new Error("会话包含未完成的轮次");
}

export function checkpointOf(value: unknown, messages: Message[]): ContextCheckpoint {
  if (value === undefined) return { through: 1, summary: "" };
  const c = object(value);
  if (typeof c.through !== "number" || !Number.isInteger(c.through) ||
    c.through < 1 || c.through > messages.length || typeof c.summary !== "string") {
    throw new Error("摘要检查点无效");
  }
  if ((c.through === 1 && c.summary !== "") || (c.through > 1 && !c.summary.trim())) {
    throw new Error("摘要与覆盖范围不一致");
  }
  const next = messages[c.through];
  if (next && (next.role !== "user" || typeof next.content !== "string")) {
    throw new Error("摘要必须在完整轮次之间切分");
  }
  return { through: c.through, summary: c.summary };
}