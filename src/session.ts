import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Message } from "./types.js";

interface SessionMetadata {
  version: 1;
  id: string;
  createdAt: string;
  cwd: string;
  modelId: string;
}

export class SessionStore {
  private constructor(
    public readonly filePath: string,
    private readonly metadata: SessionMetadata,
  ) {}

  static async create(
    modelId: string,
    systemPrompt: string,
  ): Promise<SessionStore> {
    const cwd = process.cwd();
    const directory = resolve(cwd, ".na", "sessions");

    await mkdir(directory, { recursive: true });

    const id = randomUUID();

    const session = new SessionStore(
      join(directory, `${id}.json`),
      {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        cwd,
        modelId,
      },
    );

    await session.save([
      {
        role: "system",
        content: systemPrompt,
      },
    ]);

    return session;
  }

  async save(messages: Message[]): Promise<void> {
    const data = {
      ...this.metadata,
      updatedAt: new Date().toISOString(),
      messages,
    };

    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;

    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(data, null, 2) + "\n",
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );

      // 完整写入临时文件后，再替换会话文件。
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});

      const detail =
        error instanceof Error ? error.message : String(error);

      throw new Error(`会话保存失败：${detail}`);
    }
  }
}