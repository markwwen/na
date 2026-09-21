import { selectionOf } from "./model.js";
import { ContextManager, CONTEXT_LIMITS } from "./context.js";
import { assertHistory, checkpointOf } from "./history.js";
import type { ContextCheckpoint, SessionSnapshot } from "./history.js";
import { callLLM } from "./client.js";
import { executeTool, toolDefinitions } from "./tools.js";

import type {
  StreamEvent,
  Message,
  ModelConfig,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

const MAX_MODEL_CALLS = 20;

export class Agent {
  private messages: Message[];
  private checkpoint: ContextCheckpoint;

constructor(
  private model: ModelConfig,
  private readonly systemPrompt: string,
  private readonly onToolCall?: (call: ToolUseBlock) => void,
  private readonly saveMessages?: (state: SessionSnapshot) => Promise<void>,
  private readonly onStream?: (event: StreamEvent) => void,
  initial?: SessionSnapshot,
  private readonly onNotice?: (text: string) => void,
) {
  this.messages = structuredClone(initial?.messages ?? this.createInitialMessages());
  assertHistory(this.messages);
  this.checkpoint = checkpointOf(initial?.context, this.messages);
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

    for (let step = 0; step < MAX_MODEL_CALLS; step++) {
      const input = await context.prepare(working, signal, { pendingTurn: true });
      const { message, stopReason } = await callLLM(
        this.model,
        input,
        toolDefinitions,
        this.onStream,
        signal,
      );

      signal?.throwIfAborted();

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

          results.push(await executeTool(call, signal));
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

      return answer;

    }

    throw new Error(
      `本轮已达到 ${MAX_MODEL_CALLS} 次模型请求上限`,
    );
  }

  async setModel(next: ModelConfig, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.saveMessages?.(structuredClone({
      messages: this.messages, context: this.checkpoint, model: selectionOf(next),
    }));
    this.model = structuredClone(next);
  }

  reset(): void {
    this.messages = this.createInitialMessages();
    this.checkpoint = { through: 1, summary: "" };
  }

  contextInfo() {
    const context = this.createContext();
    return {
      budgetChars: CONTEXT_LIMITS.maxInputChars,
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
    return true;
  }

  private createContext(): ContextManager {
    return new ContextManager(this.model, this.systemPrompt, toolDefinitions, this.checkpoint, this.onNotice);
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
