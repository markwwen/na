import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { thinkingLevel, type CliOptions } from "./cli.js";
import { messagesUrl, reasoningParameters, requestHeaders } from "./model.js";
import { THINKING_LEVELS, type ModelConfig, type ModelSelection, type ThinkingLevel } from "./types.js";

type Dict = Record<string, unknown>;
export interface ResolveOptions { provider?: string; model?: string; thinking?: ThinkingLevel; maxTokens?: number; }
interface Entry { provider: string; id: string; config: Dict; }
const providerName = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const modelName = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/;

function object(value: unknown, label: string): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Dict;
}
function merge(a: Dict, b: Dict): Dict {
  const result = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("配置包含不支持的键名");
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(a[key] && typeof a[key] === "object" && !Array.isArray(a[key]) ? a[key] as Dict : {}, value as Dict)
      : value;
  }
  return result;
}
async function readJson(path: string, optional = true): Promise<Dict> {
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`无法读取配置：${path}`);
  }
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`配置 JSON/JSONC 无效：${path}，位置 ${errors[0]!.offset}`);
  return merge({}, object(value, path));
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value;
}
function integer(value: unknown, label: string, min = 1, max = 2_147_483_647): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min}～${max} 的整数`);
  return value;
}
function normalize(raw: Dict): Dict {
  const result = { ...raw };
  if (raw.defaultModel === undefined && raw.model !== undefined) result.defaultModel = raw.model;
  if (raw.defaultThinkingLevel === undefined && raw.effortLevel !== undefined) result.defaultThinkingLevel = raw.effortLevel;
  return result;
}

// 与当前 pi 的 $VAR / ${VAR} / $$ / $! 写法一致。普通大写字符串仍是字面值。
export function resolveValue(value: unknown, env: NodeJS.ProcessEnv, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  if (value.startsWith("!")) throw new Error(`${label} 使用了 !command；本版不执行凭据命令，请改用 $ENV_VAR`);
  return value.replace(/\$(\$|!|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (_, token: string) => {
    if (token === "$" || token === "!") return token;
    const key = token.startsWith("{") ? token.slice(1, -1) : token;
    if (!env[key]) throw new Error(`${label} 引用的环境变量 ${key} 未设置`);
    return env[key]!;
  });
}

export class ConfigCatalog {
  private constructor(
    public readonly cli: CliOptions,
    public readonly files: string[],
    private readonly settings: Dict,
    private readonly entries: Entry[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly configDir: string,
    private readonly cwd: string,
  ) {}

  static async load(cli: CliOptions, options: { cwd?: string; userDirectory?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ConfigCatalog> {
    const cwd = options.cwd ?? process.cwd();
    const userDirectory = options.userDirectory ?? homedir();
    const processEnv = options.env ?? process.env;
    const configDir = processEnv.NA_CONFIG_DIR ? resolve(cwd, processEnv.NA_CONFIG_DIR) : join(userDirectory, ".na", "agent");
    const files: string[] = [];
    let settings: Dict = {};
    let models: Dict = {};
    const addSettings = async (path: string, optional = true) => { settings = merge(settings, normalize(await readJson(path, optional))); files.push(path); };
    if (cli.source === "pi") {
      const pi = processEnv.PI_CODING_AGENT_DIR ? resolve(cwd, processEnv.PI_CODING_AGENT_DIR) : join(userDirectory, ".pi", "agent");
      await addSettings(join(pi, "settings.json"));
      await addSettings(join(cwd, ".pi", "settings.json"));
      models = merge(models, await readJson(join(pi, "models.json")));
      files.push(join(pi, "models.json"));
    } else if (cli.source === "claude") {
      const claude = processEnv.CLAUDE_CONFIG_DIR ? resolve(cwd, processEnv.CLAUDE_CONFIG_DIR) : join(userDirectory, ".claude");
      await addSettings(join(claude, "settings.json"));
      await addSettings(join(cwd, ".claude", "settings.json"));
      await addSettings(join(cwd, ".claude", "settings.local.json"));
    }
    await addSettings(join(configDir, "settings.json"));
    await addSettings(join(cwd, ".na", "settings.json"));
    await addSettings(join(cwd, ".na", "settings.local.json"));
    if (cli.settingsFile) await addSettings(resolve(cwd, cli.settingsFile), false);
    models = merge(models, await readJson(join(configDir, "models.json")));
    files.push(join(configDir, "models.json"));

    const env: NodeJS.ProcessEnv = {};
    // settings.env 只用于请求配置解析，不改写 process.env 或命令运行环境。
    if (settings.env !== undefined) {
      for (const [key, value] of Object.entries(object(settings.env, "env"))) {
        if (typeof value !== "string") throw new Error(`env.${key} 必须是字符串`);
        env[key] = value;
      }
    }
    for (const [key, value] of Object.entries(processEnv)) if (value !== undefined) env[key] = value;
    const entries: Entry[] = [];
    const providers = models.providers === undefined ? {} : object(models.providers, "providers");
    for (const [provider, value] of Object.entries(providers)) {
      if (!providerName.test(provider)) throw new Error("provider 名称无效");
      const p = object(value, `providers.${provider}`);
      if (p.models === undefined) continue;
      if (!Array.isArray(p.models)) throw new Error(`providers.${provider}.models 必须是数组`);
      const ids = new Set<string>();
      for (const raw of p.models) {
        const model = object(raw, "model");
        const id = text(model.id, "model.id");
        if (!modelName.test(id) || ids.has(id)) throw new Error(`provider ${provider} 中有无效或重复的 model.id`);
        ids.add(id);
        entries.push({ provider, id, config: merge(p, model) });
      }
    }
    // 无 models.json 时，允许沿用 NA_* / ANTHROPIC_* 的单网关配置。
    if (!entries.length && cli.source !== "pi") {
      let id = cli.model ?? env.NA_MODEL ?? env.ANTHROPIC_MODEL ?? env.ANTHROPIC_DEFAULT_MODEL ?? settings.defaultModel;
      if (id === undefined && env.NA_BASE_URL) id = "deepseek";
      if (typeof id === "string" && ["opus", "sonnet", "haiku"].includes(id)) {
        id = env[`ANTHROPIC_DEFAULT_${id.toUpperCase()}_MODEL`];
        if (!id) throw new Error("Claude 模型别名需要对应 ANTHROPIC_DEFAULT_*_MODEL；也可直接使用完整 model ID");
      }
      if (id !== undefined) {
        if (!modelName.test(text(id, "model"))) throw new Error("model ID 无效");
        const provider = text(cli.provider ?? env.NA_PROVIDER ?? settings.defaultProvider ?? "default", "provider");
        if (!providerName.test(provider)) throw new Error("provider 名称无效");
        const token = env.NA_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
        const keyReference = env.NA_API_KEY ? "$NA_API_KEY" : env.ANTHROPIC_AUTH_TOKEN ? "$ANTHROPIC_AUTH_TOKEN" : env.ANTHROPIC_API_KEY ? "$ANTHROPIC_API_KEY" : "";
        if (env.NA_API_KEY && !env.NA_BASE_URL && !env.ANTHROPIC_BASE_URL) throw new Error("沿用 NA_API_KEY 时请同时设置 NA_BASE_URL，或在 models.json 明确配置提供商");
        const adaptive = settings.thinkingMode === "adaptive";
        entries.push({ provider, id: id as string, config: {
          api: "anthropic-messages", baseUrl: env.NA_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
          apiKey: keyReference, authHeader: !!token,
          reasoning: true, maxTokens: 65536,
          compat: { forceAdaptiveThinking: adaptive },
          thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
        } });
        settings = { ...settings, defaultProvider: settings.defaultProvider ?? provider, defaultModel: settings.defaultModel ?? id };
      }
    }
    return new ConfigCatalog(cli, files, settings, entries, env, configDir, cwd);
  }

  list() {
    return this.entries.map(e => ({ provider: e.provider, id: e.id, name: e.config.name ?? e.id,
      api: e.config.api, reasoning: e.config.reasoning === true }));
  }

  resolve(overrides: ResolveOptions = {}): ModelConfig {
    const s = this.settings;
    let provider = overrides.provider ?? this.cli.provider ?? this.env.NA_PROVIDER ?? s.defaultProvider;
    let id = overrides.model ?? this.cli.model ?? this.env.NA_MODEL ?? this.env.ANTHROPIC_MODEL ?? this.env.ANTHROPIC_DEFAULT_MODEL ?? s.defaultModel;
    if (typeof id === "string" && ["opus", "sonnet", "haiku"].includes(id)) {
      id = this.env[`ANTHROPIC_DEFAULT_${id.toUpperCase()}_MODEL`];
      if (!id) throw new Error("模型别名尚未映射；请设置 ANTHROPIC_DEFAULT_*_MODEL 或使用完整 model ID");
    }
    if (typeof id === "string" && !this.entries.some(e => e.provider === provider && e.id === id)) {
      // 只把已注册的 provider 前缀视为限定名；保留模型 ID 自身的斜杠。
      const prefix = id.split("/")[0]!;
      if (id.includes("/") && this.entries.some(e => e.provider === prefix)) {
        if (overrides.provider && overrides.provider !== prefix) throw new Error("provider 与 model 前缀冲突");
        provider = prefix; id = id.slice(prefix.length + 1);
      }
    }
    const matches = this.entries.filter(e => (provider === undefined || e.provider === provider) && (id === undefined || e.id === id));
    if (!matches.length) throw new Error("未找到模型。请配置 ~/.na/agent/models.json 和 settings.json，或使用 --config-source pi / claude");
    if (matches.length !== 1) throw new Error("模型不唯一，请使用 provider/modelId");
    const selected = matches[0]!;
    const c = selected.config;
    if (c.api !== "anthropic-messages") throw new Error(`本版仅实现 anthropic-messages；${selected.provider}/${selected.id} 使用 ${String(c.api)}`);
    const compat = c.compat === undefined ? {} : object(c.compat, "compat");
    if (compat.supportsMidConvoEffort === true) throw new Error("暂不支持 supportsMidConvoEffort 的专用协议；请使用本版支持的模型配置");
    const reasoning = c.reasoning === true;
    if (c.reasoning !== undefined && typeof c.reasoning !== "boolean") throw new Error("reasoning 必须是布尔值");
    const perModel = s.modelThinkingLevels === undefined ? {} : object(s.modelThinkingLevels, "modelThinkingLevels");
    const envEffort = this.env.NA_THINKING_LEVEL ?? this.env.CLAUDE_CODE_EFFORT_LEVEL;
    const level = thinkingLevel(overrides.thinking ?? this.cli.thinking ??
      (envEffort === "auto" ? undefined : envEffort) ?? perModel[`${selected.provider}/${selected.id}`] ?? s.defaultThinkingLevel ?? "off");
    const map = c.thinkingLevelMap === undefined ? {} : object(c.thinkingLevelMap, "thinkingLevelMap");
    for (const [key, value] of Object.entries(map)) {
      if (!THINKING_LEVELS.includes(key as ThinkingLevel) || (value !== null && typeof value !== "string")) throw new Error("thinkingLevelMap 无效");
    }
    if (map[level] === null || (!reasoning && level !== "off") || (["xhigh", "max"].includes(level) && map[level] === undefined)) {
      throw new Error(`此模型未声明支持 ${level} 推理强度`);
    }
    const capability = integer(c.maxTokens ?? 16384, "model.maxTokens");
    const maxTokens = integer(overrides.maxTokens ?? this.cli.maxTokens ??
      (this.env.NA_MAX_TOKENS === undefined ? undefined : Number(this.env.NA_MAX_TOKENS)) ?? s.maxTokens ?? capability, "maxTokens", 1, capability);
    const budgets = s.thinkingBudgets === undefined ? {} : object(s.thinkingBudgets, "thinkingBudgets");
    const defaults = { off: 0, minimal: 1024, low: 4096, medium: 10240, high: 32768, xhigh: 32768, max: 32768 };
    const adaptive = compat.forceAdaptiveThinking === true;
    if (compat.forceAdaptiveThinking !== undefined && typeof compat.forceAdaptiveThinking !== "boolean") throw new Error("forceAdaptiveThinking 必须是布尔值");
    if (c.authHeader !== undefined && typeof c.authHeader !== "boolean") throw new Error("authHeader 必须是布尔值");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(c.headers === undefined ? {} : object(c.headers, "headers"))) {
      headers[key] = resolveValue(value, this.env, `headers.${key}`);
    }
    let key = c.apiKey;
    let authHeader = c.authHeader === true;
    if (key === undefined && selected.provider === "anthropic") {
      if (this.env.ANTHROPIC_AUTH_TOKEN) { key = "$ANTHROPIC_AUTH_TOKEN"; authHeader = c.authHeader === undefined ? true : authHeader; }
      else if (this.env.ANTHROPIC_API_KEY) key = "$ANTHROPIC_API_KEY";
    }
    const baseUrl = text(c.baseUrl, "baseUrl");
    messagesUrl(baseUrl);
    const model: ModelConfig = {
      provider: selected.provider, id: selected.id, api: "anthropic-messages", baseUrl,
      apiKey: resolveValue(key ?? "", this.env, "apiKey"), authHeader, headers,
      maxTokens, thinkingLevel: level, thinkingMode: adaptive ? "adaptive" : "budget",
      ...(level === "off" ? {} : {
        thinkingBudget: integer(budgets[level] ?? defaults[level], `thinkingBudgets.${level}`, 1024),
        effort: typeof map[level] === "string" ? map[level] as string : adaptive ? (level === "minimal" ? "low" : level) : undefined,
      }),
      requestTimeoutMs: integer(Number(this.env.NA_REQUEST_TIMEOUT_MS ?? this.env.API_TIMEOUT_MS ?? s.requestTimeoutMs ?? 300000), "requestTimeoutMs"),
      idleTimeoutMs: integer(Number(this.env.NA_IDLE_TIMEOUT_MS ?? s.idleTimeoutMs ?? 60000), "idleTimeoutMs"),
    };
    if (s.temperature !== undefined) {
      if (typeof s.temperature !== "number" || !Number.isFinite(s.temperature) || s.temperature < 0 || s.temperature > 1) throw new Error("temperature 必须在 0～1 之间");
      model.temperature = s.temperature;
    }
    reasoningParameters(model); requestHeaders(model);
    return model;
  }

  describe(model: ModelConfig) {
    return { provider: model.provider, model: model.id, thinkingLevel: model.thinkingLevel,
      thinkingMode: model.thinkingMode, requestThinking: reasoningParameters(model), maxTokens: model.maxTokens, temperature: model.temperature,
      baseUrl: model.baseUrl, apiKeyConfigured: !!model.apiKey, customHeaderNames: Object.keys(model.headers),
      requestTimeoutMs: model.requestTimeoutMs, idleTimeoutMs: model.idleTimeoutMs,
      source: this.cli.source ?? "na", searchedConfigFiles: this.files };
  }

  async saveDefaults(selection: ModelSelection, scope: "global" | "project"): Promise<string> {
    const path = scope === "global" ? join(this.configDir, "settings.json") : join(this.cwd, ".na", "settings.local.json");
    const current = await readJson(path);
    const levels = current.modelThinkingLevels === undefined ? {} : object(current.modelThinkingLevels, "modelThinkingLevels");
    const next = { ...current, defaultProvider: selection.provider, defaultModel: selection.id,
      defaultThinkingLevel: selection.thinkingLevel,
      modelThinkingLevels: { ...levels, [`${selection.provider}/${selection.id}`]: selection.thinkingLevel } };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return path;
  }
}
