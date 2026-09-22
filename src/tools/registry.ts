import type { AgentTool, ToolDefinition, ToolResultBlock, ToolUseBlock } from "../types.js";

// 工具定义和执行函数使用同一份注册结果；不隐式添加内置工具。
export class ToolRegistry {
  private readonly toolsByName = new Map<string, AgentTool>();
  readonly definitions: ToolDefinition[];

  constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      if (this.toolsByName.has(tool.name)) throw new Error(`工具重名：${tool.name}`);
      this.toolsByName.set(tool.name, { ...tool });
    }
    this.definitions = [...this.toolsByName.values()].map(({ name, description, input_schema }) => ({
      name, description, input_schema,
    }));
  }

  async execute(call: ToolUseBlock, signal?: AbortSignal): Promise<ToolResultBlock> {
    try {
      signal?.throwIfAborted();

      const tool = this.toolsByName.get(call.name);

      if (!tool) {
        throw new Error(`未知工具：${call.name}`);
      }

      // 等待工具自己完成取消和清理。
      // 写入和命令执行不能只通过 abortable 停止等待。
      const content = await tool.execute(call.input, signal);

      signal?.throwIfAborted();

      return {
        type: "tool_result",
        tool_use_id: call.id,
        content,
      };
    } catch (error) {
      // 用户取消中断整轮；普通工具错误交回模型处理。
      signal?.throwIfAborted();

      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: error instanceof Error
          ? error.message
          : String(error),
        is_error: true,
      };
    }
  }
}
