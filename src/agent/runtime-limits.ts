import type { ContextLimits } from "../types.js";

// 0 表示不限主循环请求次数；取消、超时和上下文预算仍然有效。
export const MAX_MODEL_CALLS = 0;

export const CONTEXT_LIMITS: ContextLimits = {
  maxInputChars: 480_000,
  keepTurns: 2,
  maxSummaryChars: 6_000,
  batchChars: 24_000,
  reserveTokens: 16_384,
};

export function validateContextSize(limits: ContextLimits): void {
  const required = limits.batchChars + limits.maxSummaryChars + 4000;
  if (limits.maxInputChars < required) {
    throw new Error(`contextLimits.maxInputChars 至少为 batchChars + maxSummaryChars + 4000，即 ${required}`);
  }
}

export function validateContextLimits(limits: ContextLimits): void {
  const { maxInputChars, keepTurns, maxSummaryChars, batchChars, reserveTokens } = limits;
  if (![maxInputChars, keepTurns, maxSummaryChars, batchChars, reserveTokens].every(Number.isSafeInteger) ||
    keepTurns < 0 || reserveTokens < 0 || batchChars < 1000 || maxSummaryChars < 100) {
    throw new Error("上下文配置无效：各项都必须是整数，且 keepTurns ≥ 0、reserveTokens ≥ 0、batchChars ≥ 1000、" +
      "maxSummaryChars ≥ 100、maxInputChars ≥ batchChars + maxSummaryChars + 4000");
  }
  validateContextSize(limits);
}

export function validateMaxModelCalls(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("maxModelCalls 必须是非负整数，0 表示不限次数");
  }
}
