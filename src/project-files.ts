import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// No shell execution, special files, outside-root links, or unbounded reads.
export async function readProjectText(root: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (!await exists(path)) return undefined;
  const canonical = await realpath(path);
  if (!isWithin(root, canonical)) throw new Error(`文件指向项目目录之外：${path}`);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`文件必须是普通文本且不超过 ${maxBytes} 字节：${path}`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    signal?.throwIfAborted();
    if (size > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节：${path}`);
    const result = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    if (result.includes("\0")) throw new Error(`不支持二进制文件：${path}`);
    return result;
  } finally { await handle.close(); }
}
