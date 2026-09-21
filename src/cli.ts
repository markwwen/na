import { THINKING_LEVELS } from "./types.js";
import type { ThinkingLevel } from "./types.js";

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
}
export function thinkingLevel(value: unknown): ThinkingLevel {
  if (!THINKING_LEVELS.includes(value as ThinkingLevel)) throw new Error(`推理强度应为 ${THINKING_LEVELS.join(" / ")}`);
  return value as ThinkingLevel;
}
export function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") { result.help = true; continue; }
    if (arg === "--version" || arg === "-v") { result.version = true; continue; }
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
  --help / --version

配置：~/.na/agent/settings.json、models.json
项目：.na/settings.json、.na/settings.local.json
命令：/model、/thinking、/effort、/config、/config save [global|project]
`;
