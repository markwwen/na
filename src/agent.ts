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

constructor(
  private readonly model: ModelConfig,
  private readonly systemPrompt: string,
  private readonly onToolCall?: (call: ToolUseBlock) => void,
  private readonly saveMessages?: (messages: Message[]) => Promise<void>,
  private readonly onStream?: (event: StreamEvent) => void,
) {
  this.messages = this.createInitialMessages();
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

    for (let step = 0; step < MAX_MODEL_CALLS; step++) {
      const { message, stopReason } = await callLLM(
        this.model,
        working,
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
      await this.saveMessages?.(structuredClone(working));

      this.messages = working;

      return answer;

    }

    throw new Error(
      `本轮已达到 ${MAX_MODEL_CALLS} 次模型请求上限`,
    );
  }

  reset(): void {
    this.messages = this.createInitialMessages();
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