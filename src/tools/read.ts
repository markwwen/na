import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { abortable } from "../agent/control.js";
import type { AgentTool } from "../types.js";

export const readTools: AgentTool[] = [
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

