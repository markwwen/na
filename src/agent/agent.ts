import { selectionOf } from "../llm/model.js";
import { ContextManager } from "./context.js";
import { assertHistory, checkpointOf } from "./history.js";
import type { ContextCheckpoint, SessionSnapshot } from "./history.js";
import { callLLM } from "../llm/client.js";
import { ToolRegistry } from "../tools/registry.js";
import { DEFAULT_CONTEXT_WINDOW, inputTokenBudget, type UsageCalibration } from "./budget.js";

import type {
  AgentTool,
  ContextLimits,
  StreamEvent,
  Message,
  ModelConfig,
  ToolResultBlock,
  ToolUseBlock,
} from "../types.js";

import { CONTEXT_LIMITS, MAX_MODEL_CALLS, validateContextLimits, validateMaxModelCalls } from "./runtime-limits.js";

export interface AgentOptions {
  model: ModelConfig;
  systemPrompt: string;
  tools: AgentTool[];
  initialState?: SessionSnapshot;
  save?: (state: SessionSnapshot) => Promise<void>;
  onToolCall?: (call: ToolUseBlock) => void;
  onStream?: (event: StreamEvent) => void;
  onNotice?: (text: string) => void;
  limits?: ContextLimits;
  maxModelCalls?: number;
}

export class Agent {
  private model: ModelConfig;
  private systemPrompt: string;
  private messages: Message[];
  private checkpoint: ContextCheckpoint;
  private registry: ToolRegistry;
  private calibration?: UsageCalibration;
  private limits: ContextLimits;
  private maxModelCalls: number;
  private readonly saveMessages?: AgentOptions["save"];
  private readonly onToolCall?: AgentOptions["onToolCall"];
  private readonly onStream?: AgentOptions["onStream"];
  private readonly onNotice?: AgentOptions["onNotice"];

  constructor(options: AgentOptions) {
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.registry = new ToolRegistry(options.tools);
    this.saveMessages = options.save;
    this.onToolCall = options.onToolCall;
    this.onStream = options.onStream;
    this.onNotice = options.onNotice;
    this.messages = structuredClone(options.initialState?.messages ?? this.createInitialMessages());
    assertHistory(this.messages);
    this.checkpoint = checkpointOf(options.initialState?.context, this.messages);
    this.limits = { ...(options.limits ?? CONTEXT_LIMITS) };
    this.maxModelCalls = options.maxModelCalls ?? MAX_MODEL_CALLS;
    this.validateLimits(this.limits, this.maxModelCalls);
  }

  async setEnvironment(systemPrompt: string, tools: AgentTool[], signal?: AbortSignal,
    limits: ContextLimits = this.limits, maxModelCalls: number = this.maxModelCalls): Promise<void> {
    signal?.throwIfAborted();
    const registry = new ToolRegistry(tools);
    this.validateLimits(limits, maxModelCalls);
    const messages: Message[] = [{ role: "system", content: systemPrompt }, ...this.messages.slice(1)];
    await this.saveMessages?.(structuredClone({ messages, context: this.checkpoint, model: selectionOf(this.model) }));
    this.messages = messages;
    this.systemPrompt = systemPrompt;
    this.registry = registry;
    this.setLimits(limits, maxModelCalls);
    this.calibration = undefined;
  }

  // 只影响后续请求的预算检查和循环上限；两者都不写入会话文件，也不改动已归档的历史。
  setLimits(next: ContextLimits, maxModelCalls: number = this.maxModelCalls): void {
    this.validateLimits(next, maxModelCalls);
    this.limits = { ...next };
    this.maxModelCalls = maxModelCalls;
  }

  private validateLimits(limits: ContextLimits, maxModelCalls: number): void {
    validateMaxModelCalls(maxModelCalls);
    validateContextLimits(limits);
    inputTokenBudget(this.model, limits);
  }

  runtimeLimits() {
    return { contextLimits: { ...this.limits }, maxModelCalls: this.maxModelCalls };
  }

  async prompt(text: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const content = text.trim();

    if (!content) {
      throw new Error("消息不能为空");
    }

    const working: Message[] = [
      ...this.messages,
      { role: "user", content },
    ];

    const context = this.createContext();

    for (let step = 0; this.maxModelCalls === 0 || step < this.maxModelCalls; step++) {
      const input = await context.prepare(working, signal, { pendingTurn: true });
      const { message, stopReason, usage } = await callLLM(
        this.model,
        input,
        this.registry.definitions,
        this.onStream,
        signal,
        context.estimate(input).tokens,
      );

      signal?.throwIfAborted();
      context.observe([...input, message], usage);

      if (stopReason === "max_tokens") {
        throw new Error("模型输出被截断，本轮未完成");
      }

      const calls = message.content.filter(
        (block): block is ToolUseBlock => block.type === "tool_use",
      );

      if (stopReason === "tool_use") {
        if (calls.length === 0) {
          throw new Error("模型表示需要调用工具，但未返回 tool_use");
        }

        // 先保留模型提出的工具调用。
        working.push(message);

        const results: ToolResultBlock[] = [];

        for (const call of calls) {
          signal?.throwIfAborted();

          this.onToolCall?.(call);

          results.push(await this.registry.execute(call, signal));
        }

        // 同一条回复里的所有工具结果，
        // 集中放在紧随其后的 user 消息里。
        working.push({
          role: "user",
          content: results,
        });

        // 把结果发给模型，让它继续处理任务。
        continue;
      }

      if (
        stopReason !== "end_turn" &&
        stopReason !== "stop_sequence"
      ) {
        throw new Error(`暂不支持的停止原因：${stopReason}`);
      }

      if (calls.length > 0) {
        throw new Error("模型返回了工具调用，但停止原因不是 tool_use");
      }

      const answer = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      if (!answer.trim()) {
        throw new Error("模型未返回最终文本回答");
      }

      working.push(message);

      // 进入保存前允许取消。
      signal?.throwIfAborted();

      // 保存与内存提交作为一个整体完成。
      await this.saveMessages?.(structuredClone({ messages: working, context: context.checkpoint, model: selectionOf(this.model) }));

      this.messages = working;
      this.checkpoint = context.checkpoint;
      this.calibration = context.calibration;

      return answer;

    }

    throw new Error(
      `本轮已达到 ${this.maxModelCalls} 次模型请求上限；可在 settings.json 调大 maxModelCalls 或设为 0 取消限制`,
    );
  }

  async setModel(next: ModelConfig, signal?: AbortSignal, systemPrompt: string = this.systemPrompt): Promise<void> {
    signal?.throwIfAborted();
    inputTokenBudget(next, this.limits);
    const messages: Message[] = [{ role: "system", content: systemPrompt }, ...this.messages.slice(1)];
    await this.saveMessages?.(structuredClone({
      messages, context: this.checkpoint, model: selectionOf(next),
    }));
    this.messages = messages;
    this.systemPrompt = systemPrompt;
    this.model = structuredClone(next);
    this.calibration = undefined;
  }

  reset(): void {
    this.messages = this.createInitialMessages();
    this.checkpoint = { through: 1, summary: "" };
    this.calibration = undefined;
  }

  contextInfo() {
    const context = this.createContext();
    const estimate = context.estimate(context.render(this.messages));
    return {
      budgetChars: this.limits.maxInputChars,
      contextWindow: this.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      budgetTokens: inputTokenBudget(this.model, this.limits),
      reserveTokens: this.limits.reserveTokens,
      requestTokens: estimate.tokens,
      tokenSource: estimate.source,
      maxModelCalls: this.maxModelCalls,
      messages: this.messages.length,
      turns: this.messages.filter(m => m.role === "user" && typeof m.content === "string").length,
      summarizedMessages: this.checkpoint.through - 1,
      summaryChars: this.checkpoint.summary.length,
      requestChars: context.size(context.render(this.messages)),
    };
  }

  async compact(signal?: AbortSignal): Promise<boolean> {
    const context = this.createContext();
    await context.prepare(this.messages, signal, { force: true });
    if (context.checkpoint.through === this.checkpoint.through) return false;
    signal?.throwIfAborted();
    await this.saveMessages?.(structuredClone({ messages: this.messages, context: context.checkpoint, model: selectionOf(this.model) }));
    this.checkpoint = context.checkpoint;
    this.calibration = undefined;
    return true;
  }

  private createContext(): ContextManager {
    return new ContextManager(this.model, this.systemPrompt, this.registry.definitions, this.checkpoint, this.onNotice, this.limits, this.calibration);
  }

  private createInitialMessages(): Message[] {
    return [
      {
        role: "system",
        content: this.systemPrompt,
      },
    ];
  }
}
