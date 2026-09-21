import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";

import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import { abortable } from "./control.js";
import { argumentsOf } from "./file-tools.js";
import type { AgentTool } from "./types.js";

async function runCommand(
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const args = argumentsOf(input);

  if (
    typeof args.command !== "string" ||
    !args.command.trim() ||
    args.command.includes("\0")
  ) {
    throw new Error(
      "command 必须是非空字符串，且不能包含 NUL",
    );
  }

  const command = args.command;
  const cwdArg = args.cwd ?? ".";
  const timeoutMs = args.timeout_ms ?? 60_000;

  if (typeof cwdArg !== "string" || !cwdArg.trim()) {
    throw new Error("cwd 无效");
  }

  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  ) {
    throw new Error("timeout_ms 必须是 1～300000 的整数");
  }

  if (process.platform === "win32") {
    throw new Error("本版命令执行仅支持 macOS / Linux");
  }

  const root = await abortable(
    () => realpath(process.cwd()),
    signal,
  );

  const cwd = await abortable(
    () => realpath(resolve(root, cwdArg)),
    signal,
  );

  const rel = relative(root, cwd);

  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("cwd 必须位于当前工作目录内");
  }

  const info = await abortable(() => stat(cwd), signal);

  if (!info.isDirectory()) {
    throw new Error("cwd 必须是目录");
  }

  signal?.throwIfAborted();

  return new Promise<string>((resolveResult, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;

      return {
        add(chunk: Buffer) {
          const kept = chunk.subarray(
            0,
            Math.max(0, 32 * 1024 - bytes),
          );

          if (kept.length) chunks.push(kept);

          bytes += kept.length;

          if (kept.length < chunk.length) {
            truncated = true;
          }
        },

        result: () => ({
          text: Buffer.concat(chunks).toString("utf8"),
          truncated,
        }),
      };
    };

    const stdout = capture();
    const stderr = capture();

    // 超过保存上限后仍读取数据，避免管道堵塞。
    child.stdout.on("data", stdout.add);
    child.stderr.on("data", stderr.add);

    let failure: Error | undefined;
    let timedOut = false;
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (kind: NodeJS.Signals) => {
      if (!child.pid) return;

      try {
        // 负 PID 表示向整个进程组发送信号。
        process.kill(-child.pid, kind);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ESRCH"
        ) {
          failure ??= error as Error;
        }
      }
    };

    const stop = () => {
      if (stopping) return;
      stopping = true;

      killGroup("SIGTERM");

      killTimer = setTimeout(() => {
        killGroup("SIGKILL");

        // 脱离进程组的后代可能仍持有管道，
        // 不继续等待它们的输出。
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    signal?.addEventListener("abort", stop, {
      once: true,
    });

    child.once("error", (error) => {
      failure = error;
    });

    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);

      signal?.removeEventListener("abort", stop);

      // 本工具不保留同一进程组中的后台子进程。
      killGroup("SIGKILL");

      const result = JSON.stringify({
        exitCode,
        signal: exitSignal,
        timedOut,
        stdout: stdout.result(),
        stderr: stderr.result(),
      });

      if (signal?.aborted) {
        reject(signal.reason);
      } else if (failure) {
        reject(failure);
      } else if (timedOut || exitCode !== 0) {
        reject(new Error(result));
      } else {
        resolveResult(result);
      }
    });
  });
}

export const commandTool: AgentTool = {
  name: "run_command",

  description:
    "通过 /bin/sh 执行非交互命令，例如类型检查和测试。" +
    "cwd 默认为项目根目录。" +
    "默认超时 60 秒，最多 300 秒。" +
    "stdout/stderr 各保留前 32 KiB；" +
    "非零退出码或超时为工具错误。" +
    "不要启动交互程序或长期后台服务。",

  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        minLength: 1,
      },
      cwd: {
        type: "string",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: 300_000,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },

  execute: runCommand,
};