import { thinkingLevel } from "../types.js";
import type { ThinkingLevel } from "../types.js";

export interface CliOptions {
  help?: boolean;
  version?: boolean;
  resume?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  maxTokens?: number;
  source?: "na" | "pi" | "claude";
  settingsFile?: string;
  skillPaths?: string[];
  noSkills?: boolean;
}
export function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") { result.help = true; continue; }
    if (arg === "--version" || arg === "-v") { result.version = true; continue; }
    if (arg === "--no-skills") { result.noSkills = true; continue; }
    if (arg === "--skill") {
      const path = args[++i];
      if (!path || path.startsWith("--")) throw new Error("--skill 缺少路径");
      (result.skillPaths ??= []).push(path);
      continue;
    }
    const key = arg === "--effort" ? "--thinking" : arg;
    if (!["--resume", "--provider", "--model", "--thinking", "--max-tokens", "--config-source", "--settings"].includes(key)) throw new Error(`未知参数：${arg}`);
    if (seen.has(key)) throw new Error(`参数重复：${arg}`);
    seen.add(key);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少参数`);
    if (key === "--resume") result.resume = value;
    if (key === "--provider") result.provider = value;
    if (key === "--model") result.model = value;
    if (key === "--thinking") result.thinking = thinkingLevel(value);
    if (key === "--settings") result.settingsFile = value;
    if (key === "--max-tokens") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error("--max-tokens 必须是正整数");
      result.maxTokens = Number(value);
    }
    if (key === "--config-source") {
      if (!["na", "pi", "claude"].includes(value)) throw new Error("--config-source 应为 na / pi / claude");
      result.source = value as CliOptions["source"];
    }
  }
  return result;
}
export const HELP = `na - 终端 Coding Agent

用法：na [选项]
  --thinking <level>            off / minimal / low / medium / high / xhigh / max
  --effort <level>              --thinking 的别名
  --max-tokens <number>         本次运行的最大输出 token 数
  --resume <id 或前缀>          恢复当前项目中的会话
  --config-source <na|pi|claude> 读取其他工具的常用模型配置（只读）
  --settings <path>             额外的 settings.json 文件
  --skill <path>                添加 skill 目录或 SKILL.md（可重复）
  --no-skills                   禁用默认目录和 settings.skills，仍加载 --skill
  --help / --version

配置：~/.na/agent/settings.json、models.json
项目：.na/settings.json、.na/settings.local.json
命令：/model、/thinking、/effort、/config、/config save [global|project]
Skills：/skills 列表、/skill:<name> [任务说明] 调用
项目：/init [--dry-run] 生成框架、/reload 重载项目指令、skills 和预算设置
`;
