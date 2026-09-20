import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

async function resolveExistingPath(input: unknown): Promise<string> {
  if (
    typeof input !== "object" ||
    input === null ||
    !("path" in input) ||
    typeof input.path !== "string" ||
    !input.path.trim()
  ) {
    throw new Error("工具需要非空的字符串参数 path");
  }

  const root = await realpath(process.cwd());
  const target = await realpath(resolve(root, input.path));
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

async function readTextFile(input: unknown): Promise<string> {
  const filePath = await resolveExistingPath(input);
  const info = await stat(filePath);

  if (!info.isFile()) {
    throw new Error("path 必须指向普通文件");
  }

  if (info.size > 128 * 1024) {
    throw new Error("文件超过 128 KiB，本版暂不支持读取");
  }

  const text = await readFile(filePath, "utf8");

  return text.length > 20_000
    ? text.slice(0, 20_000) +
        "\n[内容已截断，仅显示前 20000 个字符]"
    : text;
}

async function listFiles(input: unknown): Promise<string> {
  const directory = await resolveExistingPath(input);
  const info = await stat(directory);

  if (!info.isDirectory()) {
    throw new Error("path 必须指向目录");
  }

  const entries = await readdir(directory, {
    withFileTypes: true,
  });

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
): Promise<ToolResultBlock> {
  try {
    const tool = toolsByName.get(call.name);

    if (!tool) {
      throw new Error(`未知工具：${call.name}`);
    }

    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: await tool.execute(call.input),
    };
  } catch (error) {
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: error instanceof Error ? error.message : String(error),
      is_error: true,
    };
  }
}