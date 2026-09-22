import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";

import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";

import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { abortable } from "../agent/control.js";
import type { AgentTool } from "../types.js";

import { argumentsOf, stringArg } from "./input.js";

const MAX_BYTES = 128 * 1024;

function inside(root: string, target: string): void {
  const rel = relative(root, target);

  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("路径必须位于当前工作目录内");
  }
}

// 文件可以不存在，但父目录必须存在。
// 父目录包含符号链接时，检查其真实位置。
async function writablePath(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!path.trim() || path.includes("\0")) {
    throw new Error("path 无效");
  }

  const root = await abortable(
    () => realpath(process.cwd()),
    signal,
  );

  const target = resolve(root, path);
  inside(root, target);

  const parent = await abortable(
    () => realpath(dirname(target)),
    signal,
  );

  inside(root, parent);

  return join(parent, basename(target));
}

async function inspect(
  path: string,
  signal?: AbortSignal,
): Promise<Stats | undefined> {
  try {
    const info = await abortable(
      () => lstat(path),
      signal,
    );

    if (!info.isFile()) {
      throw new Error(
        "目标必须是普通文件，不能是目录或符号链接",
      );
    }

    return info;
  } catch (error) {
    signal?.throwIfAborted();

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function sameFile(
  a: Stats | undefined,
  b: Stats | undefined,
): boolean {
  if (!a || !b) return a === b;

  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

async function commit(
  path: string,
  content: string,
  before: Stats | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = Buffer.byteLength(content, "utf8");

  if (bytes > MAX_BYTES) {
    throw new Error("写入结果超过 128 KiB");
  }

  signal?.throwIfAborted();

  const temporary = join(
    dirname(path),
    `.na-${randomUUID()}.tmp`,
  );

  const file = await open(temporary, "wx", 0o600);

  try {
    signal?.throwIfAborted();

    await file.writeFile(content, {
      encoding: "utf8",
      signal,
    });

    // 覆盖已有文件时保留原权限，包括可执行权限。
    await file.chmod(
      before
        ? before.mode & 0o777
        : 0o666 & ~process.umask(),
    );

    await file.close();

    // 尽量检测准备期间来自编辑器或其他进程的修改。
    if (!sameFile(before, await inspect(path, signal))) {
      throw new Error(
        "文件在操作期间发生变化，请重新读取后再修改",
      );
    }

    signal?.throwIfAborted();

    // 提交阶段：等待 rename 完成，不在中途停止等待。
    await rename(temporary, path);

    return JSON.stringify({
      path,
      bytes,
      written: true,
    });
  } finally {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

async function writeText(
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const args = argumentsOf(input);

  const path = await writablePath(
    stringArg(args, "path"),
    signal,
  );

  const content = stringArg(args, "content");
  const before = await inspect(path, signal);

  return commit(path, content, before, signal);
}

async function editText(
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const args = argumentsOf(input);

  const path = await writablePath(
    stringArg(args, "path"),
    signal,
  );

  const oldText = stringArg(args, "old_text");
  const newText = stringArg(args, "new_text");

  if (!oldText) {
    throw new Error("old_text 不能为空");
  }

  const before = await inspect(path, signal);

  if (!before) {
    throw new Error("文件不存在");
  }

  if (before.size > MAX_BYTES) {
    throw new Error("文件超过 128 KiB");
  }

  const buffer = await readFile(path, { signal });

  if (buffer.length > MAX_BYTES) {
    throw new Error("文件超过 128 KiB");
  }

  // 保留 BOM，拒绝无法正确解码的文件。
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(buffer);

  const index = text.indexOf(oldText);

  if (index < 0) {
    throw new Error(
      "未找到 old_text，请重新读取文件，检查空格和换行",
    );
  }

  if (text.indexOf(oldText, index + 1) >= 0) {
    throw new Error(
      "old_text 匹配多处，请提供更多上下文，保证唯一匹配",
    );
  }

  // 使用字符串拼接，让 $& 等内容保持字面含义。
  const result =
    text.slice(0, index) +
    newText +
    text.slice(index + oldText.length);

  return commit(path, result, before, signal);
}

export const fileTools: AgentTool[] = [
  {
    name: "write_file",
    description:
      "创建或完整覆盖当前工作目录内的 UTF-8 文件。" +
      "父目录须已存在。最多 128 KiB。" +
      "不支持符号链接目标。覆盖已有文件前先读取。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: writeText,
  },
  {
    name: "edit_file",
    description:
      "精确替换 UTF-8 文件中唯一匹配的 old_text。" +
      "空格和换行必须一致。匹配零处或多处均失败。" +
      "new_text 可为空字符串，表示删除。" +
      "文件和结果最多 128 KiB。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: {
          type: "string",
          minLength: 1,
        },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
    execute: editText,
  },
];