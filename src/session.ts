import { THINKING_LEVELS, type ModelSelection } from "./types.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertHistory, checkpointOf, object } from "./history.js";
import type { SessionSnapshot } from "./history.js";

interface Metadata {
  version: 1;
  id: string;
  createdAt: string;
  cwd: string;
  modelId: string;
}
interface SessionData extends Metadata, SessionSnapshot { updatedAt: string; }
export interface SessionEntry {
  id: string;
  updatedAt: string;
  modelId: string;
  turns: number;
  title: string;
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const directory = () => resolve(process.cwd(), ".na", "sessions");

async function readSession(id: string): Promise<SessionData> {
  if (!ID.test(id)) throw new Error("会话 ID 无效");
  const path = join(directory(), `${id}.json`);
  const info = await lstat(path);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("会话文件类型无效或超过 64 MiB");
  const data = object(JSON.parse(await readFile(path, "utf8")));
  if (data.version !== 1 || data.id !== id ||
    typeof data.modelId !== "string" || !data.modelId || typeof data.cwd !== "string" ||
    typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt)) ||
    typeof data.updatedAt !== "string" || !Number.isFinite(Date.parse(data.updatedAt))) {
    throw new Error("会话元数据无效");
  }
  if (data.model !== undefined) {
    const m = object(data.model);
    if (typeof m.provider !== "string" || !m.provider || typeof m.id !== "string" || !m.id ||
      !THINKING_LEVELS.includes(m.thinkingLevel as never) || Object.keys(m).some(k => !["provider", "id", "thinkingLevel"].includes(k))) {
      throw new Error("会话模型选择信息无效");
    }
  }
  assertHistory(data.messages);
  const context = checkpointOf(data.context, data.messages);
  return { ...(data as unknown as SessionData), context };
}

export class SessionStore {
  private constructor(
    public readonly filePath: string,
    private readonly metadata: Metadata,
    private state: SessionSnapshot,
  ) {}

  get snapshot(): SessionSnapshot { return structuredClone(this.state); }
  get id(): string { return this.metadata.id; }
  get modelId(): string { return this.state.model?.id ?? this.metadata.modelId; }

  static async create(modelId: string, systemPrompt: string, model?: ModelSelection): Promise<SessionStore> {
    await mkdir(directory(), { recursive: true });
    const id = randomUUID();
    const state: SessionSnapshot = { model, messages: [{ role: "system", content: systemPrompt }] };
    const session = new SessionStore(join(directory(), `${id}.json`), {
      version: 1, id, modelId, cwd: process.cwd(), createdAt: new Date().toISOString(),
    }, state);
    await session.save(state);
    return session;
  }

  static async list(): Promise<{ entries: SessionEntry[]; skipped: string[] }> {
    let names: string[];
    try { names = await readdir(directory()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], skipped: [] };
      throw error;
    }
    const entries: SessionEntry[] = [];
    const skipped: string[] = [];
    for (const name of names.filter(n => n.endsWith(".json"))) {
      try {
        const data = await readSession(name.slice(0, -5));
        const turns = data.messages.filter(m => m.role === "user" && typeof m.content === "string");
        const title = typeof turns[0]?.content === "string" ? turns[0].content : "（空会话）";
        entries.push({ id: data.id, updatedAt: data.updatedAt, modelId: data.modelId,
          turns: turns.length, title: title.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 60) });
      } catch { skipped.push(name); }
    }
    entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    return { entries, skipped };
  }

  static async load(prefix: string): Promise<SessionStore> {
    const key = prefix.toLowerCase();
    if (!/^[0-9a-f-]{4,36}$/.test(key)) throw new Error("请输入完整 ID 或至少 4 位 ID 前缀");
    let id = key;
    if (!ID.test(key)) {
      const { entries } = await this.list();
      const matches = entries.filter(e => e.id.startsWith(key));
      if (!matches.length) throw new Error("未找到可恢复的会话");
      if (matches.length > 1) throw new Error("ID 前缀不唯一，请输入更多字符");
      id = matches[0]!.id;
    }
    const data = await readSession(id);
    const { version, createdAt, cwd, modelId } = data;
    return new SessionStore(join(directory(), `${id}.json`),
      { version, id, createdAt, cwd, modelId },
      { messages: data.messages, context: data.context, model: data.model });
  }

  async save(state: SessionSnapshot): Promise<void> {
    const next = structuredClone(state);
    assertHistory(next.messages);
    next.context = checkpointOf(next.context, next.messages);
    const data = { ...this.metadata, modelId: next.model?.id ?? this.metadata.modelId, updatedAt: new Date().toISOString(), ...next };
    const serialized = JSON.stringify(data, null, 2) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > 64 * 1024 * 1024) throw new Error("会话超过 64 MiB，请新建会话");
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      await rename(temporary, this.filePath);
      this.state = next;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new Error(`会话保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
