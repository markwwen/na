export interface ModelConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
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
  content: (TextBlock | ToolUseBlock)[];
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
  execute: (input: unknown) => Promise<string>;
}