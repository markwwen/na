import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

// Startup only: Node preserves existing process.env values, including empty strings.
export function loadProjectEnv(cwd = process.cwd()): boolean {
  const path = resolve(cwd, ".env");
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > 128 * 1024) throw new Error("Invalid env file");
    loadEnvFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Do not include file contents or parser diagnostics that may contain credentials.
    throw new Error(`无法加载 ${path}：请确认它是可读的普通 .env 文件，且不超过 128 KiB`);
  }
}
