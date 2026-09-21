export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

// 会话中只保存选择信息，不保存密钥或请求头。
export interface ModelSelection {
  provider: string;
  id: string;
  thinkingLevel: ThinkingLevel;
}

export interface ModelConfig extends ModelSelection {
  api: "anthropic-messages";
  baseUrl: string;
  apiKey: string;
  authHeader: boolean;
  headers: Record<string, string>;
  maxTokens: number;
  thinkingMode: "budget" | "adaptive";
  thinkingBudget?: number;
  effort?: string;
  temperature?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface AssistantMessage {
  role: "assistant";
  content: (
    | TextBlock
    | ToolUseBlock
    | ThinkingBlock
    | RedactedThinkingBlock
  )[];
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ToolResultBlock[] }
  | AssistantMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMResponse {
  message: AssistantMessage;
  stopReason: string | null;
}

export interface AgentTool extends ToolDefinition {
  execute: (
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<string>;
}

export type StreamEvent =
  | { type: "start"; kind: "text" | "thinking" }
  | { type: "delta"; kind: "text" | "thinking"; text: string }
  | { type: "end"; kind: "text" | "thinking" };
