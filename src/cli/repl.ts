import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { App } from "../app.js";
import type { CliOptions } from "./args.js";
import type { createStreamPrinter } from "./renderer.js";
import { thinkingLevel } from "../types.js";
import { TaskCancelledError, RequestTimeoutError } from "../agent/control.js";
import { applyInit, planInit } from "../project/init.js";

function showSession(app: App): void {
  const project = app.projectInfo;
  console.log(`会话文件：${app.sessionInfo.filePath}`);
  console.log(`[model] ${app.modelLabel}`);
  for (const file of project.files) console.log(`[instructions] ${file}`);
  console.log(`[skills] 已发现 ${project.skills.length} 个；/skills 查看列表`);
  for (const warning of project.diagnostics) console.warn(`[skills] ${warning}`);
}

function showReload(app: App): void {
  const { contextLimits: limits, maxModelCalls } = app.runtimeLimits();
  const project = app.projectInfo;
  console.log(`[reload] 已加载 ${project.files.length} 份项目指令和 ${project.skills.length} 个 skills；` +
    `输入字符预算 ${limits.maxInputChars}，预留 ${limits.reserveTokens} tokens，保留最近 ${limits.keepTurns} 轮，` +
    (maxModelCalls === 0 ? "每轮模型请求次数不限。" : `每轮最多 ${maxModelCalls} 次模型请求。`) +
    "保留当前会话和模型。");
  for (const file of project.files) console.log(`[instructions] ${file}`);
  for (const warning of project.diagnostics) console.warn(`[skills] ${warning}`);
}

export async function runRepl(app: App, cli: CliOptions, streamPrinter: ReturnType<typeof createStreamPrinter>): Promise<void> {
  showSession(app);
  const rl = createInterface({ input, output });
  const lifetime = new AbortController();

  let closed = false;
  let currentTask: AbortController | undefined;

  const interrupt = () => {
    if (currentTask) {
      currentTask.abort(new TaskCancelledError());
    } else {
      rl.close();
    }
  };

  // 终端键盘 Ctrl+C。
  rl.on("SIGINT", interrupt);

  // 外部进程发送的 SIGINT。
  process.on("SIGINT", interrupt);

  rl.on("close", () => {
    closed = true;

    // 结束可能正在等待的 question。
    lifetime.abort();

    // Ctrl+D 等关闭输入的情况，也取消当前任务。
    currentTask?.abort(new TaskCancelledError());
  });

  console.log(
    "/model 模型，/thinking 推理强度，/effort 同义命令，/config 配置；\n" +
    "/skills 列表，/skill:<name> [任务说明] 调用；\n" +
    "/init [--dry-run] 项目框架，/reload 重载项目指令、skills 和预算设置；\n" +
    "/sessions 列表，/resume <id> 恢复，/context 上下文，/compact 压缩；\n" +
    "/clear 新会话，/quit 退出；" +
    "运行时 Ctrl+C 取消，空闲时 Ctrl+C 退出。\n",
  );

  try {
    while (!closed) {
      let text: string;

      try {
        text = (
          await rl.question("> ", {
            signal: lifetime.signal,
          })
        ).trim();
      } catch (error) {
        if (closed) break;
        throw error;
      }

      if (closed || text === "/quit") break;
      if (!text) continue;

      // 每轮都创建新的 controller，不能复用已取消的 signal。
      currentTask = new AbortController();

      try {
        const [command, ...params] = text.split(/\s+/);
        const signal = currentTask.signal;
        if (command === "/init" && (params.length === 0 || (params.length === 1 && params[0] === "--dry-run"))) {
          const dryRun = params[0] === "--dry-run";
          const plan = await planInit(process.cwd(), signal);
          const results = await applyInit(plan, dryRun, signal);
          console.table(results.map(result => ({ 文件: result.path, 状态: dryRun && result.status === "created" ? "planned" : result.status, 说明: result.detail ?? "" })));
          for (const message of plan.diagnostics) console.log(`[init] ${message}`);
          if (dryRun) {
            for (const file of plan.files) {
              if (results.some(result => result.path === file.path && result.status === "created")) console.log(`\n--- ${file.path} ---\n${file.content}`);
            }
          } else {
            console.log("[init] 已完成可写入项；已有文件保留。命令清单来自静态扫描，尚未运行项目检查。");
            await app.reload(signal);
            showReload(app);
          }
        } else if (command === "/reload" && params.length === 0) {
          await app.reload(signal);
          showReload(app);
        } else if (command === "/skills" && params.length === 0) {
          console.table(app.projectInfo.skills.map(skill => ({ 名称: skill.name, 说明: skill.description,
            调用方式: skill.disableModelInvocation ? "仅手动" : "自动 / 手动", 文件: skill.file })));
          if (!app.projectInfo.skills.length) console.log("没有发现 skills。将 SKILL.md 放入 .na/skills/<name>/ 或 ~/.na/agent/skills/<name>/。");
          for (const warning of app.projectInfo.diagnostics) console.warn(`[skills] ${warning}`);
        } else if (command?.startsWith("/skill:")) {
          const name = command.slice("/skill:".length);
          const expanded = await app.expandSkill(name, text.slice(command.length).trim(), signal);
          console.log(`[skill] ${name}`);
          await app.prompt(expanded, signal);
        } else if ((command === "/config" || command === "/settings") && params.length === 0) {
          console.log(JSON.stringify(app.configuration(), null, 2));
        } else if (command === "/config" && params[0] === "save" && params.length <= 2) {
          const scope = params[1] ?? "global";
          if (scope !== "global" && scope !== "project") throw new Error("用法：/config save [global|project]");
          const path = await app.saveDefaults(scope);
          console.log(`默认模型和推理强度已保存：${path}`);
          console.log("CLI、环境变量或更高优先级项目设置仍可覆盖它们。");
        } else if (command === "/model" && params.length <= 2) {
          if (!params.length) {
            const models = await app.listModels(signal);
            console.log(`[model] ${app.modelLabel}`);
            console.table(models);
          } else {
            await app.selectModel(params[0]!, params[1] === undefined ? undefined : thinkingLevel(params[1]), signal);
            console.log(`[model] ${app.modelLabel}`);
          }
        } else if ((command === "/thinking" || command === "/effort") && params.length <= 1) {
          if (!params.length) console.log(`[model] ${app.modelLabel}`);
          else {
            await app.setThinking(thinkingLevel(params[0]), signal);
            console.log(`[model] ${app.modelLabel}`);
          }
        } else if (command === "/sessions" && params.length === 0) {
          const { entries, skipped } = await app.listSessions();
          signal.throwIfAborted();
          console.table(entries.map(e => ({
            当前: e.id === app.sessionInfo.id ? "*" : "",
            ID: e.id, 轮次: e.turns, 更新时间: e.updatedAt, 标题: e.title,
          })));
          if (skipped.length) console.log(`跳过 ${skipped.length} 个损坏或不兼容的会话文件。`);
        } else if (command === "/resume" && params.length === 1) {
          await app.resume(params[0]!, signal);
          showSession(app);
          console.log("已恢复会话，将使用当前系统提示词继续对话。\n");
        } else if (command === "/clear" && params.length === 0) {
          await app.newSession(signal);
          showSession(app);
          console.log("已开始新会话，旧会话文件已保留。\n");
        } else if (command === "/context" && params.length === 0) {
          const info = app.contextInfo();
          console.table({
            历史消息数: info.messages, 完成轮次: info.turns,
            已摘要消息数: info.summarizedMessages, 摘要字符数: info.summaryChars,
            当前请求估算字符数: info.requestChars, 输入字符预算: info.budgetChars,
            模型窗口tokens: info.contextWindow, 输入预算tokens: info.budgetTokens,
            预留tokens: info.reserveTokens, 当前请求估算tokens: info.requestTokens,
            token估算依据: info.tokenSource === "usage" ? "usage + 新增内容估算" : "内容估算",
            每轮请求上限: info.maxModelCalls === 0 ? "不限" : info.maxModelCalls,
          });
          console.log("估算包含系统提示词和工具定义，不包含下一条用户输入；token 用量并非精确预计算。\n");
        } else if (command === "/compact" && params.length === 0) {
          console.log(await app.compact(signal)
            ? "摘要已保存，完整历史仍保留。\n"
            : "较早的完整轮次不足，无需压缩。\n");
        } else if (text.startsWith("/")) {
          throw new Error("未知命令或参数数量错误。支持 /init [--dry-run]、/reload、/skills、/skill:<name>、/model、/thinking、/effort、/config、/sessions、/resume <id>、/context、/compact、/clear、/quit");
        } else {
          await app.prompt(text, signal);
        }

        if (currentTask.signal.aborted) {
          console.log("\n本轮已进入保存阶段，已完成保存。");
        }
      } catch (error) {
        streamPrinter.finish();

        if (error instanceof TaskCancelledError) {
          console.error("\n已取消当前任务。");
        } else if (error instanceof RequestTimeoutError) {
          console.error(`\n请求超时：${error.message}`);
        } else {
          const message = error instanceof Error
            ? error.message
            : String(error);

          console.error(`\n操作失败：${message}`);
        }

        console.error(
          "操作未完成，原有会话仍可继续；已执行的文件修改或命令不会自动撤销。" +
          "可以重新输入。\n",
        );
      } finally {
        // 每轮结束：清理任务状态，继续等待输入。
        currentTask = undefined;
        streamPrinter.finish();
      }
    }
  } finally {
    // 整个输入循环结束：关闭终端输入，显示恢复命令。
    process.off("SIGINT", interrupt);
    rl.close();
    streamPrinter.finish();

    if (app.sessionInfo.id) {
      console.log(
        "\n下次在当前项目目录运行以下命令，即可恢复会话：\n",
      );

      const command = ["na"];
      if (cli.source && cli.source !== "na") command.push("--config-source", cli.source);
      if (cli.settingsFile) command.push("--settings", cli.settingsFile);
      if (cli.maxTokens !== undefined) command.push("--max-tokens", String(cli.maxTokens));
      if (cli.noSkills) command.push("--no-skills");
      for (const path of cli.skillPaths ?? []) command.push("--skill", path);
      command.push("--resume", app.sessionInfo.id);
      const quote = (value: string) => /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
      console.log("  " + command.map(quote).join(" ") + "\n");
    }
  }
}
