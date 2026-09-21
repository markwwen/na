<p align="center">
  <img src="./assets/na.png"  alt="na 娘" />
</p>

> 呐（na）！有什么能为您服务的吗？

一个使用 TypeScript 从零实现的轻量级终端 Coding Agent，参考 Pi 的能力逐步迭代，用于学习模型调用、工具执行、流式交互和会话管理。

当前可以在终端中与模型对话，让模型自主查看目录、读取和修改代码、执行类型检查和测试，同时显示 thinking 和工具调用过程。


## 安装

需要 Node.js 22+、npm。当前命令执行工具支持 macOS / Linux。

从源码安装：

```bash
git clone git@github.com:markwwen/na.git
cd na
npm ci
npm run typecheck
npm run build
npm link
na --help
```

`npm link` 将当前仓库的 `dist/main.js` 注册为 `na` 命令。以后修改源码后，在仓库内重新执行 `npm run build`，命令即可使用新版本。如果 shell 提示找不到 `na`，检查 `$(npm prefix -g)/bin` 是否在 `PATH` 中。

完成下面的模型配置后，可以在任意项目目录启动：

```bash
cd /path/to/your-project
na
```

工具操作和会话保存均以启动时的目录为基准。

## 配置模型

全局配置分为两个文件：

| 文件 | 用途 |
|---|---|
| `~/.na/agent/models.json` | 注册提供商、服务地址、认证方式及模型能力 |
| `~/.na/agent/settings.json` | 选择默认模型、推理强度、输出预算、上下文预算和超时 |

先创建目录，再将下面的 JSON 分别保存到对应文件；已有配置时合并需要的字段：

```bash
mkdir -p ~/.na/agent
```

### 1. 配置 `models.json`

下面以提供 Anthropic Messages 兼容接口的 Deepseek/GLM 服务为例。将 `baseUrl` 和模型 `id` 改为实际服务的地址及模型名称。

```json
{
  "providers": {
    "deepseek": {
      "api": "anthropic-messages",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKey": "$DEEPSEEK_API_KEY",
      "authHeader": true,
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DeepSeek on SGLang",
          "reasoning": true,
          "maxTokens": 65536,
          "thinkingLevelMap": {
            "minimal": null,
            "low": null,
            "medium": null,
            "high": "high",
            "xhigh": null,
            "max": "max"
          }
        }
      ]
    },
     "glm": {
      "api": "anthropic-messages",
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "apiKey": "$GLM_API_KEY",
      "authHeader": true,
      "models": [
        {
          "id": "glm-5.3-flash",
          "name": "GLM 5.3 Flash",
          "reasoning": true,
          "maxTokens": 16384
        }
      ]
    }
  }
}

```

| 字段 | 说明 |
|---|---|
| `api` | 当前只支持 `anthropic-messages` |
| `baseUrl` | 可填写服务根地址、以 `/v1` 结尾的地址或完整 `/v1/messages` 地址，程序会规范化请求路径 |
| `apiKey` | `$NA_API_KEY` 表示读取同名环境变量；也支持 `${NA_API_KEY}`。普通字符串按字面值使用 |
| `authHeader` | `true` 使用 `Authorization: Bearer …`；`false` 或省略时使用 `x-api-key` |
| `models[].id` | 请求发送的模型名称，必须与服务端一致 |
| `models[].reasoning` | 是否允许开启 thinking；不支持推理时设为 `false`，并选择 `off` |
| `models[].maxTokens` | 本地声明的最大输出 token 上限，应按服务能力填写 |
| `models[].contextWindow` | 模型输入与输出共用的 token 窗口，应按服务能力填写；未配置时按 500000 预算，不代表自动识别出的容量 |
| `models[].thinkingLevelMap` | 将 na 推理档位映射到请求的 `output_config.effort`；`null` 表示该档位不可用 |

示例声明了 `off`、`high`、`max` 三个可选档位；其中 `high`、`max` 需要服务端支持对应的 effort 值。按实际部署调整映射。若服务只接受 `thinking.budget_tokens`，可删除 `thinkingLevelMap`，并在设置中选择 `high` 等普通档位；`xhigh` 和 `max` 必须显式声明映射才能使用。

在启动 na 的终端设置密钥：

```bash
export DEEPSEEK_API_KEY="your-api-key"
# 或者
export GLM_API_KEY="your-api-key"

```

也可以在**启动 na 的项目目录**创建 `.env`，无需每次手动 export：

```dotenv
DEEPSEEK_API_KEY="your-api-key"
GLM_API_KEY="your-api-key"
```

na 在读取模型配置和初始化终端显示前，使用 [Node 内置的 `.env` 加载功能](https://nodejs.org/docs/latest-v22.x/api/process.html#processloadenvfilepath) 读取该文件；`na` 与 `npm run dev` 都适用。

- 终端已有的同名环境变量优先，包括显式设置的空字符串；`.env` 仅补充未设置的变量。
- 只读取启动目录的 `.env`，不向父目录查找，也不自动加载 `.env.local`；文件不存在时正常启动。
- 支持注释、带引号的值及 `export KEY=value` 写法。含 `#` 的密钥应加引号；不执行 shell 命令，也不对值里的 `$VAR` 做变量展开。
- 加载后的变量参与模型配置解析，并由 `run_command` 子进程继承。`--help` 和 `--version` 不读取 `.env`。
- `.env` 只在启动时加载，修改后需重启；`/reload` 不重新读取它。文件须为可读的普通文件，最大 128 KiB。

引用的环境变量为空或未设置时，选择该模型会报错。服务无需认证时，将 `apiKey` 改为 `""`。`.env` 已在 `.gitignore` 中，不提交实际密钥。

### 2. 配置 `settings.json`

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-flash",
  "defaultThinkingLevel": "max",
  "maxTokens": 65536,
  "thinkingBudgets": {
    "high": 4096,
    "max": 4096
  },
  "requestTimeoutMs": 300000,
  "idleTimeoutMs": 60000,
  "maxModelCalls": 0,
  "contextLimits": {
    "maxInputChars": 480000,
    "keepTurns": 2,
    "reserveTokens": 16384
  }
}
```

`defaultProvider` 和 `defaultModel` 必须对应 `models.json` 中的名称。这里保留了最初版本的 `budget_tokens: 4096` 和 `effort: "max"`。

`models.json` 中的 `reasoning: true` 只声明模型支持推理，不会自动开启 thinking。未指定推理强度时默认使用 `off`；要默认开启，需要设置 `defaultThinkingLevel`。如果恢复的旧会话保存了 `off`，进入 REPL 后执行 `/thinking max`，或启动时使用 `na --resume <id> --thinking max` 覆盖。

`thinkingBudgets` 控制各档位的推理 token 预算上限，不保证模型一定输出这么长的 thinking。`maxTokens` 是包含 thinking 的总输出预算，不能超过模型声明的上限；请求层会为回答预留至少 1024 个 token。启用预算模式的 thinking 时，`maxTokens` 至少为 2048。

`requestTimeoutMs` 是每次模型请求的总超时；`idleTimeoutMs` 是连续未收到网络数据的超时，SSE 心跳也会刷新它。两者单位均为毫秒，取值范围为 1～2147483647。

`maxModelCalls` 控制一次用户任务中主循环的模型请求次数，不是用户对话轮数，也不包含摘要请求。默认 `0` 表示不限次数；设为正整数（如 `100`）可保留硬上限。不限次数时仍可用 Ctrl+C 取消，单次请求超时和上下文预算仍然有效；重复工具调用不会仅因达到固定次数而停止。达到显式上限或取消时，本轮消息不保存，已执行的工具副作用不会回滚。

`contextLimits` 按字段覆盖默认值：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `reserveTokens` | 16384 | 从模型窗口中预留的输出空间，输入估算超过剩余窗口时触发压缩 |
| `maxInputChars` | 480000 | 额外的输入序列化字符上限，与 token 预算同时检查 |
| `keepTurns` | 2 | 压缩时优先保留的最近完整轮次，空间不足时会减少 |
| `batchChars` | 24000 | 单批摘要记录的字符上限 |
| `maxSummaryChars` | 6000 | 新摘要的字符上限 |

各项须为非负整数，且 `batchChars ≥ 1000`、`maxSummaryChars ≥ 100`、`maxInputChars ≥ batchChars + maxSummaryChars + 4000`。模型窗口必须容纳预留空间和必要输出，否则启动、切换模型或 `/reload` 会报错。

输入 token 估算优先使用最近有效响应的 usage（包含缓存读写及输出），再加上新增消息的估算；流式 usage 按累计值覆盖，遵循 [Anthropic 流式协议](https://platform.claude.com/docs/en/build-with-claude/streaming)。没有有效 usage 时，ASCII 内容约按四字符/token，非 ASCII 按每个 UTF-16 单元一 token 估算，同时计算系统提示词和工具定义。这不是精确 tokenizer，仍可能与服务端计量有差异。

usage 校准只保存在当前进程内存中；恢复会话、切换模型、重载环境，或压缩/过滤 thinking 导致请求前缀变化后，先退回内容估算，再由新响应校准。旧会话格式保持兼容。实际请求的 `max_tokens` 还会按剩余窗口收缩，并额外留出 1024 tokens 安全余量；预算模式的 thinking 会同步收缩，保留必要的回答空间。即使将 `reserveTokens` 设为 0，也会保留安全余量和最小输出空间。

压缩仍只处理完整的早期轮次，当前任务的工具调用链不拆分；当前任务过大、旧摘要在调小预算后无法容纳，或摘要请求自身超出模型窗口时会明确报错，不发送超出本地估算预算的请求。小窗口模型需相应调低预留量、摘要长度和批次大小。

`/context` 显示当前实际使用的窗口、预留量和估算依据；`/config` 显示当前生效的预算和调用上限。修改 `contextLimits`、`maxModelCalls` 后执行 `/reload` 即可在当前会话生效；`/model` 列表不会替当前 Agent 应用这些设置。修改 `models.json` 的 `contextWindow` 后需重新选择模型或重启；`/reload` 保留当前模型配置。

### 3. 启动与切换

```bash
na
na --model deepseek/glm --thinking high
na --model sglang/deepseek --thinking off
na --resume <会话 ID 或前缀>
```

`--effort` 是 `--thinking` 的别名。进入 REPL 后，用 `/config` 查看解析后的配置，用 `/model` 列出模型，用 `/thinking high` 切换推理强度。

`--model` 和 `/model` 接受 `provider/modelId`、唯一的模型 ID，或仅包含一个模型的 provider 名称。例如注册了 `deepseek/deepseek-flash` 后，`na --model deepseek` 和 `/model deepseek` 都能选择它。解析时优先匹配真实模型 ID；出现多个候选时会列出完整名称，不会自动任选一个。显式选择模型不继承较低优先级的默认 provider；同级显式指定的 `--provider` 仍限制选择范围。思考强度独立解析，需要时加上 `--thinking high` 或使用 `/model deepseek high`。

切换结果会保存在当前会话中。若希望作为新会话的默认值，执行 `/config save`；仅针对当前项目则执行 `/config save project`。用 `/sessions` 查看可恢复的 ID；退出时也会打印恢复命令。

示例输入：

```text
查看当前目录下都有哪些文件

告诉我这个项目如何启动

查看 src 目录，读取必要文件，解释 Agent 的工具调用循环
```

## REPL 命令

| 命令 | 作用 |
|---|---|
| `/init` | 在启动目录生成项目指令和验证 skill，保留已有文件，完成后自动重载 |
| `/init --dry-run` | 显示计划写入的文件和内容，不写入框架文件 |
| `/reload` | 重新加载项目指令、skills、`contextLimits` 与 `maxModelCalls`，保留当前会话、模型及推理强度 |
| `/skills` | 列出已发现的 skills、描述、文件路径及加载诊断 |
| `/skill:<name> [任务说明]` | 加载指定 skill 并开始一轮任务，例如 `/skill:code-review 检查 src/agent.ts` |
| `/model` | 列出可用模型及当前选择 |
| `/model <provider/id> [thinking]` | 切换当前会话的模型，可同时指定推理强度 |
| `/thinking [level]`、`/effort [level]` | 查看或切换推理强度，具体可用档位由模型配置决定 |
| `/config`、`/settings` | 查看当前配置和查找的文件路径，不显示密钥及自定义请求头的值 |
| `/config save` | 将当前模型和推理强度保存为全局默认值 |
| `/config save project` | 将当前选择保存到项目的 `.na/settings.local.json` |
| `/sessions` | 列出历史会话：轮次、更新时间、标题；跳过损坏或不兼容的文件 |
| `/resume <id>` | 恢复指定会话及其模型选择，支持完整 ID 或至少 4 位唯一前缀 |
| `/context` | 显示历史与摘要、模型 token 窗口、输入预算、预留量、估算依据及每轮请求上限 |
| `/compact` | 手动压缩较早的对话；可压缩的完整轮次不足时不做改动 |
| `/clear` | 开始新会话，保留旧会话文件 |
| `/quit` | 退出程序 |
| `Ctrl+C` | 任务执行中取消当前任务；空闲时退出程序 |

## 配置覆盖与迁移

配置文件按以下顺序合并，后面的同名字段覆盖前面的字段：

1. 显式指定 `--config-source pi` 或 `--config-source claude` 时读取的外部配置。
2. `~/.na/agent/settings.json`。
3. 启动目录中的 `.na/settings.json`。
4. 启动目录中的 `.na/settings.local.json`。
5. `--settings <path>` 指定的额外文件。

项目配置按启动目录查找，不向父目录查找。`models.json` 从全局配置目录读取，不读取项目中的同名文件。配置支持 JSONC 注释和尾逗号；对象字段（如 `contextLimits`、`thinkingBudgets`）按子字段合并，只写需要调整的项即可；`/config save` 会保留其他配置字段，但重新写为不带注释的 JSON。

新会话的模型与推理强度选择优先级为：REPL 显式切换 > CLI 参数 > 对应环境变量 > 配置文件。环境变量内部的优先级为：启动前已有变量 > 项目 `.env` > `settings.env`。配置中的 `modelThinkingLevels["provider/id"]` 优先于 `defaultThinkingLevel`；`/config save` 会同时保存这两个字段。恢复会话时优先使用会话保存的模型与推理强度，也可在启动时用 `--model`、`--thinking` 显式覆盖。

| 环境变量 | 用途 | 说明 |
|---|---|---|
| `NA_CONFIG_DIR` | 全局配置目录 | 替代默认的 `~/.na/agent` |
| `NA_PROVIDER`、`NA_MODEL` | 默认提供商和模型 | 覆盖配置文件的默认选择 |
| `NA_THINKING_LEVEL` | 默认推理强度 | 被 CLI 参数和 REPL 显式切换覆盖 |
| `NA_MAX_TOKENS` | 总输出预算 | 被 `--max-tokens` 覆盖，不得超过模型声明的上限 |
| `NA_BASE_URL` | 无模型目录时的服务地址 | 只用于未注册模型时的单网关回退；不会覆盖 `models.json` 的 `baseUrl` |
| `NA_API_KEY` | 服务密钥 | 上述示例通过 `$NA_API_KEY` 引用；单网关回退时也会读取 |
| `NA_REQUEST_TIMEOUT_MS` | 单次模型请求的总超时 | 覆盖 `requestTimeoutMs`，默认 `300000` 毫秒 |
| `NA_IDLE_TIMEOUT_MS` | 连续无网络数据的超时 | 覆盖 `idleTimeoutMs`，默认 `60000` 毫秒 |
| `NO_COLOR` | 关闭 thinking 灰底 | `TERM=dumb` 或输出非 TTY 时也使用纯文本 |

已有其他工具的配置时，可显式尝试导入：

```bash
na --config-source pi
na --config-source claude
```

na 的导入器读取 Pi 的 `~/.pi/agent/settings.json`、`models.json` 和项目 `.pi/settings.json`，或 Claude Code 的 `~/.claude/settings.json` 和项目 `.claude/settings.json`、`.claude/settings.local.json`。也支持通过 `PI_CODING_AGENT_DIR`、`CLAUDE_CONFIG_DIR` 指定导入目录。导入只读，保存配置仍写入 na 自己的目录。

目前兼容常用模型字段及 `model`、`effortLevel` 别名，模型请求仅支持 `anthropic-messages`；不导入内置模型目录、OAuth 登录、hooks 或权限配置，也不执行 `!command` 凭据命令。`settings.env` 仅参与请求配置解析，不注入工具命令环境，且同名进程环境变量优先。

System 提示词仍在 `src/main.ts` 的 `SYSTEM_PROMPT` 中。上下文预算的默认值在 `src/context.ts` 的 `CONTEXT_LIMITS`：输入上限 480000 字符、保留最近 2 轮、单批摘要输入 24000 字符、摘要上限 6000 字符、预留 16384 tokens；运行时由 settings 的 `contextLimits` 逐字段覆盖，实际生效值可用 `/config` 查看。

## Skills

Skills 是可复用的任务说明，使用 [Agent Skills 的 `SKILL.md` 格式](https://agentskills.io/specification)：文件顶部是 YAML 元数据，后面是 Markdown 正文。启动时只将名称、描述和位置加入系统提示词；任务匹配时，模型通过 `load_skill` 读取完整说明。也可以用 `/skill:<name>` 明确调用，正文会随本轮用户消息传给模型。

### 创建与使用

项目 skill 放在 `.na/skills/<name>/SKILL.md`，所有项目共享的 skill 放在 `~/.na/agent/skills/<name>/SKILL.md`。例如：

```text
.na/skills/code-review/
├── SKILL.md
└── references/
    └── checklist.md
```

`SKILL.md` 最小示例：

```markdown
---
name: code-review
description: 检查代码中的行为错误、边界条件和回归风险。用于用户要求代码审查的任务。
---

先读取用户指定的文件及相关调用点，再检查错误处理和边界条件。
只报告有代码依据的问题，注明文件路径、触发条件和影响。
默认提供审查结果；用户要求修复时再修改文件。
```

执行 `/reload` 或重新启动 na 后输入：

```text
/skills
/skill:code-review 检查 src/agent.ts 的工具调用循环
```

仓库包含可直接尝试的示例，带一个按需读取的检查清单：

```bash
na --skill ./examples/skills/code-review
```

`name` 必须为 1～64 个小写字母、数字或单连字符，不能以连字符开头或结尾。`description` 必须是 1～1024 字符的非空字符串，支持 YAML 多行文本。名称可以与目录名不同。添加 `disable-model-invocation: true` 可将 skill 从模型目录中隐藏，仅允许用户通过 `/skill:<name>` 调用。

### 发现路径和迁移

发现顺序如下；同名 skill 保留先发现的版本，并显示冲突提示：

1. `--skill <path>` 指定的目录或 `SKILL.md`，参数可重复。
2. 配置文件的 `skills` 数组。
3. 当前项目的 `.na/skills/`、`.agents/skills/`。
4. 全局配置目录下的 `skills/`（默认 `~/.na/agent/skills/`）、`~/.agents/skills/`。

可以在 `~/.na/agent/settings.json` 中加入现有的 skill 目录：

```json
{
  "skills": ["~/.pi/agent/skills", "~/.claude/skills"]
}
```

将此字段合并到已有配置即可。项目 `.na/settings.json` 可使用 `"skills": ["../.claude/skills"]`。配置文件中的相对路径以**该配置文件所在目录**为基准；CLI 路径以启动目录为基准；支持 `~/`。后面的配置层会整体替换前面的 `skills` 数组。

递归扫描 `SKILL.md`，发现一个 skill 后不再将其子目录当作独立 skills 扫描。隐藏子目录和 `node_modules` 会跳过；支持符号链接目录并去重，避免循环。无效文件会跳过并显示诊断。当前不扫描父项目目录、独立的普通 `.md` 文件或插件包声明。

```bash
na --no-skills
na --no-skills --skill /path/to/one-skill
```

`--no-skills` 禁用默认目录和配置中的 skills，仍允许显式 `--skill`。它只控制本次发现，不删除历史消息中已保存的 skill 内容。退出时的恢复命令会保留这些 CLI 参数。

### 按需加载与边界

模型使用 `read_skill_file` 读取 skill 的参考文件、模板和脚本，路径相对于 `SKILL.md` 所在目录；即使全局 skill 位于项目外，也可以读取。该工具仅返回 skill 目录内的文本，拒绝越界路径和指向目录外的符号链接，不改变普通项目文件工具的访问范围。

加载 skill 不会执行脚本；需要执行时，模型先读取脚本，再通过现有 `run_command` 使用其绝对路径，命令的工作目录仍为项目目录。其他 frontmatter 字段暂不解释，`allowed-tools` 不会创建权限限制，Claude Code 的参数占位符、动态命令替换及子代理执行语义暂不支持。

每个 skill 或参考文件最多 64 KiB；一次最多发现 64 个 skills，扫描最多 4096 个路径、12 层目录。创建、恢复会话或 `/reload` 时重新发现目录；修改正文会在下次加载时生效，修改名称、描述或调用方式后需重新发现。加载内容按普通会话消息保存并参与压缩；仅手动调用的 skill 在恢复会话或重载后若需要继续读取参考文件，需再次显式调用。

## `/init`：生成项目 harness 框架

在目标项目目录启动 `na` 后，可以先预览，再创建：

```text
/init --dry-run
/init
```

默认生成三个文件：

```text
AGENTS.md
.agents/skills/verify-project/
├── SKILL.md
└── references/
    └── commands.md
```

`AGENTS.md` 是简短的导航入口；`verify-project` 负责在验证改动时查找命令；`commands.md` 记录命令来源、顶层目录和待确认项。项目架构与业务规则需要根据实际代码补充，初始化不会虚构它们。

当前从 `package.json` 的常用 scripts 和 `Makefile` 的简单目标提取 build、test、lint、typecheck、check、smoke 等入口，最多保留 64 项。包管理器优先采用 `packageManager`，否则从唯一的锁文件类型判断；无法判断时留下待确认项。其他技术栈也能生成框架，但需手动补充验证命令。

初始化在本地完成，不请求模型，不安装项目依赖，也不执行提取出的命令。清单中存在命令不代表检查已经通过。默认复用已有命令，不生成重复的 `build.sh` / `test.sh`，也不自动配置 hooks、CI 或工具权限。

已有文件始终保留，重复 `/init` 只补齐缺失项，不刷新或覆盖人工编辑的内容。若已有 `CLAUDE.md` 或 `AGENTS.override.md`，不再新建 `AGENTS.md`，以免改变现有项目指令来源。无法写入的项会单独报错；已创建的文件在失败或取消后保留，可再次执行补齐。

完成后立即将新项目指令和 skills 加载到当前会话，原对话继续保留。若使用 `--no-skills` 启动，生成的 skill 仍遵守该开关，不会自动注册。查看和调用：

```text
/skills
/skill:verify-project 验证本次修改
```

### 项目指令加载规则

na 从最近的 Git 根目录逐层读取到启动目录；未找到 Git 根目录时，只检查启动目录。每层采用首个非空文件，顺序为 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`。指令按从上到下的顺序拼接，局部规则在所属目录范围内优先；项目指令不能覆盖用户明确要求和系统约束。

加载总量最多 24 KiB，超出时明确报错，不静默截断。当前不递归加载整个仓库的局部规则，也不展开 `@import`；修改更深目录前，模型需按任务读取相关局部说明。项目指令是模型遵循的指导，不是权限系统。

修改指令或 skills 后执行 `/reload`，无需新建会话。`/init` 始终作用于**启动目录**，不会自动切换到 Git 根目录；建议在希望初始化的项目根目录启动。

关于为什么默认选择这一小框架，见 [harness 设计评审](docs/harness-design.md)。

## 工作流程

```text
用户输入
   ↓
Agent 组织历史消息和工具定义
   ↓
模型生成，SSE 增量交给终端显示
   ↓
拼接完整的模型消息
   ├── 请求调用工具
   │      ↓
   │   执行工具，将结果加入消息历史
   │      ↓
   │   再次请求模型
   │
   └── 返回最终回答
          ↓
       保存会话并提交内存历史
```

工具参数接收完整、模型消息结束后，才会开始执行工具。

屏幕显示与会话保存相互独立：屏幕可以先显示部分内容，但只有本轮完成并成功写入文件后，才会提交完整历史。

## 内置工具

| 工具 | 参数示例 | 行为与限制 |
|---|---|---|
| `list_files` | `{"path":"."}` | 列出直接子项，不递归；包含隐藏项，最多返回 100 项 |
| `read_file` | `{"path":"src/agent.ts"}` | 读取 UTF-8 文本；文件不超过 128 KiB，最多返回前 20000 个字符 |
| `write_file` | `{"path":"agent-demo.txt","content":"hello na"}` | 创建或完整覆盖 UTF-8 文件；父目录须已存在；最多 128 KiB；不支持符号链接目标 |
| `edit_file` | `{"path":"src/main.ts","old_text":"...","new_text":"..."}` | 精确替换唯一匹配的 `old_text`；匹配零处或多处均失败；`new_text` 为空表示删除 |
| `run_command` | `{"command":"npm run typecheck"}` | 通过 `/bin/sh` 执行非交互命令；默认超时 60 秒，最多 300 秒；stdout/stderr 各保留前 32 KiB；非零退出码或超时视为工具错误；仅支持 macOS / Linux |
| `load_skill` | `{"name":"code-review"}` | 按名称读取已发现的 skill 完整说明；仅发现 skills 时注册 |
| `read_skill_file` | `{"name":"code-review","path":"references/checklist.md"}` | 读取 skill 目录内的 UTF-8 文本，最多 64 KiB；仅发现 skills 时注册 |

项目文件工具的路径以启动时的工作目录为基准，会检查目标是否位于工作目录内；`run_command` 的 `cwd` 同样受此限制。`read_skill_file` 则以对应 skill 目录为基准。

## 会话保存

会话文件位于启动目录下：

```text
.na/
└── sessions/
    └── <session-id>.json
```

文件记录会话元数据，以及完整的消息历史：

- System 提示词。
- 用户输入。
- 模型文本和 thinking 内容。
- 工具调用及执行结果。
- 当前选择的提供商、模型 ID 和推理强度；不保存模型配置中的密钥。

每轮完成后，程序先写入临时文件，再替换会话文件。

当前只保存已完成的轮次。请求失败、流中断或保存失败时，本轮不会提交到内存历史；屏幕上可能已经显示部分内容。

默认启动会创建新会话，不会自动加载旧记录；用 `--resume <会话 ID 或前缀>` 启动，或在 REPL 中用 `/sessions` 查看、`/resume <id>` 切换，即可继续历史会话。

恢复时按当前配置解析会话保存的模型，因此对应的模型定义和认证仍需可用。旧会话只有模型 ID 时，会尝试在模型目录中唯一匹配；无法匹配时，可在启动时用 `--model provider/id` 指定。单个会话文件上限为 64 MiB。

## 项目结构

```text
assets/            # README 用图（na.png 形象、na-icon.svg 图标）
scripts/           # 辅助脚本，make-na-icon.mjs 生成图标
examples/skills/   # 可通过 --skill 加载的示例
tests/             # Skills、项目初始化、指令加载与 Agent 集成测试
tsconfig.json      # TypeScript 配置，编译 src 到 dist
src/
├── main.ts         # REPL、配置与模块连接
├── cli.ts          # CLI 参数解析与帮助
├── config.ts       # 配置加载、合并与默认值保存
├── env.ts          # 启动目录 .env 加载，保留已有环境变量
├── model.ts        # 模型选择、请求参数与历史推理处理
├── skills.ts       # Skill 发现、元数据解析、按需读取与调用
├── init.ts         # 项目事实提取、框架预览与保留式创建
├── instructions.ts # 项目指令发现与上下文拼接
├── project-files.ts # 有大小限制的项目文本读取
├── agent.ts        # 对话状态与工具调用循环
├── client.ts       # 模型 HTTP 请求
├── stream.ts       # SSE 解析与完整消息拼接
├── renderer.ts     # 流式终端显示与 thinking 样式
├── tools.ts        # 工具定义、注册与执行
├── file-tools.ts   # write_file 与 edit_file
├── command-tool.ts # run_command
├── control.ts      # 取消、超时与可中断等待
├── context.ts      # 上下文预算与摘要压缩
├── history.ts      # 消息历史校验与摘要检查点
├── session.ts      # 会话创建与 JSON 保存
└── types.ts        # 模型、消息、工具及事件类型
```

## 开发

运行类型检查：

```bash
npm run typecheck
npm test
```

启动开发版本：

```bash
npm run dev
```

传入启动参数：

```bash
npm run dev -- --model sglang/deepseek --thinking high
npm run dev -- --resume <会话 ID 或前缀>
```

更新已链接的 `na` 命令：

```bash
npm run build
```

重新生成 README 图标：

```bash
npm run icon
```
## 功能进度

✅ 已完成，⬜ 待实现。

| 模块 | 功能 | 状态 | 说明 |
|---|---|:---:|---|
| 对话 | 终端 REPL | ✅ | 连续输入问题并查看回复 |
| 对话 | 多轮上下文 | ✅ | 在内存中保留当前会话历史 |
| 模型 | Anthropic 兼容接口 | ✅ | 通过 `/v1/messages` 调用模型 |
| 模型 | Thinking 支持 | ✅ | 接收、显示和保留推理内容及签名 |
| 流式 | SSE 响应解析 | ✅ | 拼接网络分块、内容块和工具参数 |
| 流式 | 增量显示 | ✅ | Thinking 和回答逐步输出 |
| 界面 | Thinking 灰底显示 | ✅ | 区分推理内容、工具日志和回答 |
| 工具 | 工具注册表 | ✅ | 统一管理工具说明、参数和执行函数 |
| 工具 | `list_files` | ✅ | 查看目录中的文件和子目录 |
| 工具 | `read_file` | ✅ | 读取项目中的文本文件 |
| 工具 | `write_file` | ✅ | 创建或覆盖文件，写入前检查父目录 |
| 工具 | `edit_file` | ✅ | 精确替换文件中的唯一匹配内容 |
| 工具 | `run_command` | ✅ | 执行类型检查、测试等非交互命令 |
| Agent | 工具调用循环 | ✅ | 请求模型、执行工具、回传结果，直到完成 |
| Agent | 工具错误回传 | ✅ | 将执行错误作为工具结果交给模型 |
| Agent | 模型请求次数限制 | ✅ | 默认不限次数，可用 `maxModelCalls` 设置硬上限 |
| Agent | 流异常处理 | ✅ | 检测错误事件和连接提前结束 |
| 会话 | JSON 会话保存 | ✅ | 每轮完成后保存完整消息历史 |
| 会话 | 新建会话 | ✅ | 启动或 `/clear` 时创建新会话，保留旧文件 |
| 交互 | 取消当前任务 | ✅ | 中断正在进行的模型请求和工具执行 |
| 交互 | 请求超时 | ✅ | 为请求和长时间无响应设置超时 |
| 会话 | 会话列表与恢复 | ✅ | 查看历史会话并继续对话 |
| 上下文 | 上下文管理 | ✅ | 控制历史长度、压缩较早的消息 |
| 配置 | 模型与参数配置 | ✅ | 在配置文件或 REPL 中切换模型和推理强度 |
| CLI | `na` 命令入口 | ✅ | 在任意项目目录启动 |
| 扩展 | Skills | ✅ | 发现 `SKILL.md`，按需加载说明和参考文件，支持显式调用 |
| 扩展 | 项目指令 | ✅ | 从 Git 根目录到启动目录加载 `AGENTS.md` 等项目入口 |
| 扩展 | `/init` 项目初始化 | ✅ | 从已有配置生成最小 harness 框架，保留已有文件 |
| 扩展 | 自定义工具 | ⬜ | 通过用户配置或扩展包注册工具 |
