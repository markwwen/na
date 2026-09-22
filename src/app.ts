import { Agent, type AgentOptions } from "./agent/agent.js";
import type { CliOptions } from "./cli/args.js";
import { ConfigCatalog } from "./config/config.js";
import { selectionOf } from "./llm/model.js";
import { loadProjectInstructions, type ProjectInstructions } from "./project/instructions.js";
import { SkillCatalog } from "./project/skills.js";
import { SessionStore } from "./session/store.js";
import { builtinTools } from "./tools/builtin.js";
import type { ModelConfig, ThinkingLevel } from "./types.js";

export type AppHooks = Pick<AgentOptions, "onToolCall" | "onStream" | "onNotice">;

interface AppState {
  agent: Agent;
  model: ModelConfig;
  catalog: ConfigCatalog;
  skills: SkillCatalog;
  instructions: ProjectInstructions;
  session: SessionStore;
}

const SYSTEM_PROMPT = (model: ModelConfig) => `
You are na (呐), a coding assistant powered by the ${model.provider}/${model.id} model.
Your working directory is ${process.cwd()}.

Verify your changes by running relevant code or tests. Report what you actually checked.
Keep answers brief and factual. Respond in the user's language.

Use read_file to inspect relevant files and list_files to list directory entries.
Use write_file to create or fully overwrite files; read existing files first. Parent directories must exist.
Use edit_file for targeted changes; old_text must match exactly once.
Use run_command for searches and non-interactive commands, including tests. Prefer rg when available.
Limit command output and inspect exit codes. Do not start interactive programs or persistent background services.

Follow applicable project guidance and load relevant skills when needed. Preserve the user's existing changes.
Complete requested work within its authorized scope. When blocked, explain the blocker; do not repeat failed actions without a new approach.
`.trim();

function buildSystemPrompt(model: ModelConfig, project: ProjectInstructions, skills: SkillCatalog): string {
  return [SYSTEM_PROMPT(model), project.prompt, skills.prompt()].filter(Boolean).join("\n\n");
}

async function createSession(options: {
  cli: CliOptions;
  catalog: ConfigCatalog;
  hooks: AppHooks;
  currentModel?: ModelConfig;
  prefix?: string;
  signal?: AbortSignal;
  startup?: boolean;
}): Promise<AppState> {
  const { cli, catalog, hooks, currentModel, prefix, signal, startup } = options;
  const instructions = await loadProjectInstructions(process.cwd(), signal);
  const skills = await SkillCatalog.load(catalog.skillOptions(), signal);
  const limits = catalog.contextLimits();
  const maxModelCalls = catalog.maxModelCalls();
  let restored: SessionStore | undefined;
  let model: ModelConfig;
  if (prefix) {
    restored = await SessionStore.load(prefix);
    const saved = restored.snapshot.model;
    if (startup && (cli.model || cli.provider)) {
      model = catalog.resolve();
    } else if (saved) {
      model = catalog.resolve({ provider: saved.provider, model: saved.id,
        thinking: startup ? cli.thinking ?? saved.thinkingLevel : saved.thinkingLevel });
    } else {
      const modelId = restored.modelId;
      const matches = catalog.list().filter(m => m.id === modelId);
      if (matches.length !== 1) throw new Error("旧会话缺少 provider；请在启动时用 --model provider/id 明确指定");
      model = catalog.resolve({ provider: matches[0]!.provider, model: restored.modelId });
    }
  } else {
    model = currentModel ?? catalog.resolve();
  }
  const systemPrompt = buildSystemPrompt(model, instructions, skills);
  const session = restored ?? await SessionStore.create(model.id, systemPrompt, selectionOf(model));
  signal?.throwIfAborted();
  const agent = new Agent({
    ...hooks, model, systemPrompt, tools: [...builtinTools, ...skills.tools()],
    save: state => session.save(state), initialState: session.snapshot, limits, maxModelCalls,
  });
  // 也持久化启动时覆盖的选择和旧会话的 provider 补全。
  if (prefix) await agent.setModel(model, signal);
  return { agent, model, catalog, skills, instructions, session };
}

// 应用操作由调用方顺序执行；终端输入、输出和进程信号留在 CLI 层。
export class App {
  private constructor(
    private readonly cli: CliOptions,
    private readonly hooks: AppHooks,
    private state: AppState,
  ) {}

  static async create(cli: CliOptions, hooks: AppHooks = {}): Promise<App> {
    const catalog = await ConfigCatalog.load(cli);
    const state = await createSession({ cli, catalog, hooks, prefix: cli.resume, startup: true });
    return new App(cli, hooks, state);
  }

  get sessionInfo() { return { id: this.state.session.id, filePath: this.state.session.filePath }; }
  get modelLabel() { return `${this.state.model.provider}/${this.state.model.id} · thinking=${this.state.model.thinkingLevel}`; }
  get projectInfo() {
    return { files: [...this.state.instructions.files], skills: this.state.skills.list(),
      diagnostics: [...this.state.skills.diagnostics] };
  }

  configuration() {
    return { ...this.state.catalog.describe(this.state.model), ...this.state.agent.runtimeLimits() };
  }

  runtimeLimits() { return this.state.agent.runtimeLimits(); }
  contextInfo() { return this.state.agent.contextInfo(); }
  prompt(text: string, signal?: AbortSignal) { return this.state.agent.prompt(text, signal); }
  compact(signal?: AbortSignal) { return this.state.agent.compact(signal); }
  expandSkill(name: string, task: string, signal?: AbortSignal) { return this.state.skills.invoke(name, task, signal); }
  listSessions() { return SessionStore.list(); }

  async newSession(signal?: AbortSignal): Promise<void> {
    const next = await createSession({ cli: this.cli, catalog: this.state.catalog,
      hooks: this.hooks, currentModel: this.state.model, signal });
    this.state = next;
  }

  async resume(prefix: string, signal?: AbortSignal): Promise<void> {
    const catalog = await ConfigCatalog.load(this.cli);
    const next = await createSession({ cli: this.cli, catalog, hooks: this.hooks, prefix, signal });
    this.state = next;
  }

  async reload(signal?: AbortSignal): Promise<void> {
    const catalog = await ConfigCatalog.load(this.cli);
    const instructions = await loadProjectInstructions(process.cwd(), signal);
    const skills = await SkillCatalog.load(catalog.skillOptions(), signal);
    const systemPrompt = buildSystemPrompt(this.state.model, instructions, skills);
    // 保存成功后才提交应用状态，失败时保留原来的配置、指令和工具。
    await this.state.agent.setEnvironment(systemPrompt, [...builtinTools, ...skills.tools()], signal,
      catalog.contextLimits(), catalog.maxModelCalls());
    this.state = { ...this.state, catalog, instructions, skills };
  }

  async listModels(signal?: AbortSignal) {
    const catalog = await ConfigCatalog.load(this.cli);
    signal?.throwIfAborted();
    this.state = { ...this.state, catalog };
    return catalog.list();
  }

  async selectModel(selector: string, thinking?: ThinkingLevel, signal?: AbortSignal): Promise<void> {
    const catalog = await ConfigCatalog.load(this.cli);
    const model = catalog.resolve({ model: selector, thinking });
    await this.commitModel(catalog, model, signal);
  }

  async setThinking(thinking: ThinkingLevel, signal?: AbortSignal): Promise<void> {
    const catalog = await ConfigCatalog.load(this.cli);
    const current = this.state.model;
    const model = catalog.resolve({ provider: current.provider, model: current.id, thinking, maxTokens: current.maxTokens });
    await this.commitModel(catalog, model, signal);
  }

  private async commitModel(catalog: ConfigCatalog, model: ModelConfig, signal?: AbortSignal): Promise<void> {
    const systemPrompt = buildSystemPrompt(model, this.state.instructions, this.state.skills);
    await this.state.agent.setModel(model, signal, systemPrompt);
    this.state = { ...this.state, model, catalog };
  }

  saveDefaults(scope: "global" | "project") {
    return this.state.catalog.saveDefaults(selectionOf(this.state.model), scope);
  }
}
