import { createHash } from "node:crypto";
import { replayMessages } from "../llm/model.js";
import type { ContextLimits, Message, ModelConfig, TokenUsage, ToolDefinition } from "../types.js";

// 未声明窗口时采用的本地预算假设，不代表服务端实际容量。
export const DEFAULT_CONTEXT_WINDOW = 500_000;
export const CONTEXT_SAFETY_TOKENS = 1024;

// 只保存在当前 Agent 内存中。恢复会话后先估算，下一次响应重新校准。
export interface UsageCalibration {
  messageCount: number;
  prefixHash: string;
  tokens: number;
}

function signature(model: ModelConfig, messages: Message[], tools: ToolDefinition[]): string {
  return createHash("sha256").update(JSON.stringify({
    provider: model.provider, model: model.id, thinking: model.thinkingLevel,
    messages, tools,
  })).digest("hex");
}

function estimate(value: unknown): number {
  const text = JSON.stringify(value);
  // ASCII 约四字符/token；非 ASCII 按每个 UTF-16 单元一 token，避免中文也除以四。
  const nonAscii = text.match(/[^\x00-\x7f]/g)?.length ?? 0;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii);
}

export function calibrateUsage(
  model: ModelConfig, messages: Message[], tools: ToolDefinition[], usage?: TokenUsage,
): UsageCalibration | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const tokens = input + usage.outputTokens;
  if (input <= 0 || !Number.isSafeInteger(tokens)) return undefined;
  const replay = replayMessages(messages);
  return { messageCount: replay.length, prefixHash: signature(model, replay, tools), tokens };
}

export function estimateInputTokens(
  model: ModelConfig, messages: Message[], tools: ToolDefinition[], calibration?: UsageCalibration,
): { tokens: number; source: "usage" | "estimate" } {
  const replay = replayMessages(messages);
  if (calibration && replay.length >= calibration.messageCount &&
    signature(model, replay.slice(0, calibration.messageCount), tools) === calibration.prefixHash) {
    return { tokens: calibration.tokens + replay.slice(calibration.messageCount)
      .reduce((sum, message) => sum + estimate(message), 0), source: "usage" };
  }
  // 压缩、提示词/工具变化或历史 thinking 过滤后，旧 usage 不再描述当前前缀。
  return { tokens: estimate({ messages: replay, tools }), source: "estimate" };
}

export function minimumOutputTokens(model: ModelConfig): number {
  return model.thinkingLevel !== "off" && model.thinkingMode === "budget" ? 2048 : 1;
}

export function inputTokenBudget(model: ModelConfig, limits: ContextLimits): number {
  const window = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const budget = window - Math.max(limits.reserveTokens, CONTEXT_SAFETY_TOKENS + minimumOutputTokens(model));
  if (budget <= 0) throw new Error("模型 contextWindow 太小，无法容纳 reserveTokens 和必要的输出空间");
  return budget;
}

export function fitOutputBudget(model: ModelConfig, inputTokens: number): ModelConfig {
  const available = (model.contextWindow ?? DEFAULT_CONTEXT_WINDOW) - inputTokens - CONTEXT_SAFETY_TOKENS;
  if (available < minimumOutputTokens(model)) {
    throw new Error("上下文已占满模型窗口，无法预留必要的输出空间；请压缩历史或缩小任务");
  }
  return { ...model, maxTokens: Math.min(model.maxTokens, available) };
}
