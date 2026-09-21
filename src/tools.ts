import { fileTools } from "./file-tools.js";
import { commandTool } from "./command-tool.js";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { abortable } from "./control.js";

import type {
  AgentTool,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

const registeredTools: AgentTool[] = [
  {
    name: "read_file",
    description:
      "读取当前工作目录内的 UTF-8 文本文件。" +
      "path 相对于当前工作目录。文件不得超过 128 KiB，" +
      "最多返回前 20000 个字符，截断时会附带说明。",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "例如 src/main.ts",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: readTextFile,
  },
  {
    name: "list_files",
    description:
      "列出当前工作目录内某个目录的直接子项，不递归。" +
      'path 使用相对路径，根目录传入 "."。' +
      "包含隐藏项，标明文件、目录和符号链接，最多返回 100 项。",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "例如 . 或 src",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: listFiles,
  },
  ...fileTools,
  commandTool,
];

// 发给模型的只有说明和参数结构。
export const toolDefinitions: ToolDefinition[] = registeredTools.map(
  ({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }),
);

// 执行函数留在本地，通过名称查找。
const toolsByName = new Map(
  registeredTools.map((tool) => [tool.name, tool]),
);

async function resolveExistingPath(
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  if (
    typeof input !== "object" ||
    input === null ||
    !("path" in input) ||
    typeof input.path !== "string" ||
    !input.path.trim()
  ) {
    throw new Error("工具需要非空的字符串参数 path");
  }

  const path = input.path;

  const root = await abortable(
    () => realpath(process.cwd()),
    signal,
  );

  const target = await abortable(
    () => realpath(resolve(root, path)),
    signal,
  );

  const rel = relative(root, target);

  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("只能访问当前工作目录内的路径");
  }

  return target;
}

async function readTextFile(
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const filePath = await resolveExistingPath(input, signal);

  const info = await abortable(
    () => stat(filePath),
    signal,
  );

  if (!info.isFile()) {
    throw new Error("path 必须指向普通文件");
  }

  if (info.size > 128 * 1024) {
    throw new Error("文件超过 128 KiB，本版暂不支持读取");
  }

  const text = await abortable(
    () => readFile(filePath, { encoding: "utf8", signal }),
    signal,
  );

  return text.length > 20_000
    ? text.slice(0, 20_000) +
        "\n[内容已截断，仅显示前 20000 个字符]"
    : text;
}

async function listFiles(
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const directory = await resolveExistingPath(input, signal);

  const info = await abortable(
    () => stat(directory),
    signal,
  );

  if (!info.isDirectory()) {
    throw new Error("path 必须指向目录");
  }

  const entries = await abortable(
    () => readdir(directory, { withFileTypes: true }),
    signal,
  );

  entries.sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify(
    {
      entries: entries.slice(0, 100).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : entry.isSymbolicLink()
              ? "symlink"
              : "other",
      })),
      total: entries.length,
      truncated: entries.length > 100,
    },
    null,
    2,
  );
}

export async function executeTool(
  call: ToolUseBlock,
  signal?: AbortSignal,
  extraTools: AgentTool[] = [],
): Promise<ToolResultBlock> {
  try {
    signal?.throwIfAborted();

    const tool = toolsByName.get(call.name) ?? extraTools.find(tool => tool.name === call.name);

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
