import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { exists, isWithin, readProjectText } from "./files.js";

export interface ScaffoldFile { path: string; content: string; skipReason?: string; }
export interface InitPlan { root: string; files: ScaffoldFile[]; diagnostics: string[]; }
export interface InitResult { path: string; status: "created" | "skipped" | "error"; detail?: string; }

const SKILL_DIR = ".agents/skills/verify-project";
const COMMANDS = `${SKILL_DIR}/references/commands.md`;
const knownScripts = /^(?:build|test|typecheck|type-check|lint|check|smoke)(?::[a-z0-9_-]+)*$/;
const oneLine = (text: string) => text.replace(/[\r\n\x00-\x1f`<>|]/g, " ").slice(0, 120);

export async function planInit(cwd = process.cwd(), signal?: AbortSignal): Promise<InitPlan> {
  const root = await realpath(cwd);
  const diagnostics: string[] = [];
  const commands: { name: string; command: string; source: string }[] = [];
  const pending: string[] = [];
  let projectName = basename(root);
  const manifest = await readProjectText(root, join(root, "package.json"), 128 * 1024, signal);
  if (manifest !== undefined) {
    let pkg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(manifest);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      pkg = parsed as Record<string, unknown>;
    } catch { throw new Error("package.json 无效，尚未生成文件"); }
    if (typeof pkg.name === "string" && pkg.name.trim()) projectName = pkg.name;
    const managers = new Set<string>();
    for (const [file, manager] of [["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]]) {
      if (await exists(join(root, file!))) managers.add(manager!);
    }
    const declared = typeof pkg.packageManager === "string" ? /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager)?.[1] : undefined;
    const manager = declared ?? (managers.size === 1 ? [...managers][0] : undefined);
    if (!manager) pending.push("包管理器未明确或存在冲突；先核对 packageManager 和锁文件，再补充运行命令。");
    if (declared && [...managers].some(value => value !== declared)) diagnostics.push("锁文件与 packageManager 不一致；命令采用 packageManager 声明，请核对。");
    if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
      for (const [name, body] of Object.entries(pkg.scripts)) {
        if (manager && name.length <= 80 && knownScripts.test(name) && typeof body === "string" && body.trim() && !/(?:^|:)watch(?:$|:)/.test(name)) {
          commands.push({ name, command: `${manager} run ${name}`, source: `package.json → scripts.${name}` });
        }
      }
    }
  }
  const makefile = await readProjectText(root, join(root, "Makefile"), 128 * 1024, signal);
  if (makefile !== undefined) {
    for (const name of ["build", "test", "lint", "check", "typecheck", "smoke"]) {
      if (new RegExp(`^${name}\\s*:(?!=)`, "m").test(makefile)) commands.push({ name, command: `make ${name}`, source: `Makefile → ${name}` });
    }
  }
  if (commands.length > 64) {
    commands.length = 64;
    pending.push("验证入口较多，本清单仅保留前 64 项；其余请按任务查阅原始配置。");
  }
  if (!commands.some(c => /^(test|check|smoke)(:|$)/.test(c.name))) pending.push("尚未识别出测试或行为验证入口；按项目 README / CI 补充，不将构建成功等同于功能正确。");
  if (!commands.length) pending.push("本版自动提取 package.json scripts 和 Makefile 的常用目标；其他技术栈需补充经过确认的命令。");
  const top = await readdir(root, { withFileTypes: true });
  const locations = top.filter(entry => !entry.name.startsWith(".") && !["node_modules", "dist", "build", "vendor", "coverage"].includes(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20)
    .map(entry => `- \`${oneLine(entry.name)}${entry.isDirectory() ? "/" : ""}\``);
  const agents = [
    `# ${oneLine(projectName)} — 项目入口`, "",
    "## 项目事实", "",
    "项目用途和设计以 README 与实际代码为准；此入口由 na /init 根据当前目录生成，不推断未确认的架构。",
    "",
    "## 导航与验证", "",
    `- 已识别的目录、验证命令及待确认项：[命令清单](${COMMANDS})。`,
    `- 准备验证改动时，可使用 [verify-project skill](${SKILL_DIR}/SKILL.md)。`,
    "- 按本次任务选择需要阅读的文件及验证范围；执行结果以实际退出码和输出为准。",
    "",
    "## 项目约定", "",
    "这里仅补充无法从代码和配置直接发现的架构边界、项目约定和完成标准。当前尚无自动推断的额外规则。",
    "长期知识放入项目文档，专项流程放入 skills；权限或必须强制执行的约束由工具、CI 或沙箱实现。", "",
  ].join("\n");
  const skill = [
    "---", "name: verify-project", "description: 查找本项目的验证入口。用于选择或执行改动后的项目检查。", "---", "",
    "# 项目验证", "",
    "读取 `references/commands.md`，根据改动范围选择已有验证入口，并核对对应配置仍然存在。",
    "运行前检查相关脚本内容及环境要求；命令清单表示发现了入口，不表示它已运行、安全性已审查或测试已通过。",
    "优先运行能覆盖改动的检查。通过后如无新改动、失败或未解决的问题，不重复运行或无故扩大范围。",
    "结果说明执行的命令、退出状态、失败原因和未验证的部分；没有行为测试时明确说明。", "",
  ].join("\n");
  const reference = [
    "# 项目验证入口", "",
    "由 na /init 从项目文件静态提取；尚未执行任何命令。项目配置变化后手动更新本文件。",
    "命令以初始化目录为工作目录；开始前查看脚本内容与环境依赖，避免把命令名称当成安全性保证。", "",
    "## 命令", "",
    ...(commands.length ? ["| 入口 | 命令 | 来源 |", "|---|---|---|", ...commands.map(c => `| ${c.name} | \`${c.command}\` | ${c.source} |`)] : ["尚未发现可确认的命令入口。"]),
    "", "## 目录导航", "", ...(locations.length ? locations : ["当前目录尚无项目文件。"]),
    "", "## 待确认", "", ...pending.map(item => `- ${item}`),
    "- README / CI 中的环境前提、项目用途和架构边界需要结合实际代码补充。",
    "- 检查涉及部署、外部服务或持久化数据时，按本次任务授权确定执行范围。", "",
  ].join("\n");
  signal?.throwIfAborted();
  const existingAdapter = await exists(join(root, "AGENTS.override.md")) || await exists(join(root, "CLAUDE.md"));
  return { root, diagnostics, files: [
    { path: "AGENTS.md", content: agents, skipReason: existingAdapter ? "已有 AGENTS.override.md 或 CLAUDE.md，保留现有项目指令入口" : undefined },
    { path: `${SKILL_DIR}/SKILL.md`, content: skill },
    { path: COMMANDS, content: reference },
  ] };
}

// Check every parent without following symlinks. Existing files are never replaced.
async function targetPath(root: string, path: string, createParents: boolean): Promise<string> {
  const target = resolve(root, path);
  if (!isWithin(root, target) || target === root) throw new Error("初始化路径必须在项目内");
  const parts = relative(root, dirname(target)).split(sep).filter(Boolean);
  let parent = root;
  for (const part of parts) {
    parent = join(parent, part);
    if (createParents) {
      try { await mkdir(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`父路径不是普通目录：${parent}`);
    } catch (error) {
      if (!createParents && (error as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw error;
    }
  }
  return target;
}

export async function applyInit(plan: InitPlan, dryRun = false, signal?: AbortSignal): Promise<InitResult[]> {
  const results: InitResult[] = [];
  for (const file of plan.files) {
    signal?.throwIfAborted();
    if (file.skipReason) { results.push({ path: file.path, status: "skipped", detail: file.skipReason }); continue; }
    let temporary: string | undefined;
    try {
      const target = await targetPath(plan.root, file.path, !dryRun);
      if (await exists(target)) { results.push({ path: file.path, status: "skipped", detail: "已存在，保留原内容" }); continue; }
      if (dryRun) { results.push({ path: file.path, status: "created", detail: "预览：将创建" }); continue; }
      temporary = join(dirname(target), `.na-init-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o644);
      try { await handle.writeFile(file.content, { encoding: "utf8", signal }); }
      finally { await handle.close(); }
      signal?.throwIfAborted();
      // Atomic no-clobber publication: link fails if another writer created target.
      try { await link(temporary, target); results.push({ path: file.path, status: "created" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        results.push({ path: file.path, status: "skipped", detail: "已由其他进程创建，保留原内容" });
      }
    } catch (error) {
      signal?.throwIfAborted();
      results.push({ path: file.path, status: "error", detail: error instanceof Error ? error.message : String(error) });
    } finally { if (temporary) await rm(temporary, { force: true }); }
  }
  return results;
}
