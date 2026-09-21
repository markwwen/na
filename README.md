# na

> 呐（na）—— 会读你的项目、动手改文件的终端 Coding Agent。

一个使用 TypeScript 从零实现的轻量级终端 Coding Agent，参考 Pi 的能力逐步迭代，用于学习模型调用、工具执行、流式交互和会话管理。

当前可以在终端中与模型对话，让模型自主查看目录、读取和修改代码、执行类型检查和测试，同时显示 thinking 和工具调用过程。

## 关于 na

**na**，中文名**呐**，是一个跑在终端里的 Coding Agent。

它的身份定义在 `src/main.ts` 的 `SYSTEM_PROMPT` 常量中：启动时作为 system 消息发给模型，并写入会话文件的第一条消息。可以在会话里直接问它「你叫什么」来验证。

想改名字或人设，改这个常量即可，重启或执行 `/clear` 后生效。

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
| Agent | 模型请求次数限制 | ✅ | 每轮最多发起 20 次模型请求 |
| Agent | 流异常处理 | ✅ | 检测错误事件和连接提前结束 |
| 会话 | JSON 会话保存 | ✅ | 每轮完成后保存完整消息历史 |
| 会话 | 新建会话 | ✅ | 启动或 `/clear` 时创建新会话，保留旧文件 |
| 交互 | 取消当前任务 | ✅ | 中断正在进行的模型请求和工具执行 |
| 交互 | 请求超时 | ✅ | 为请求和长时间无响应设置超时 |
| 会话 | 会话列表与恢复 | ⬜ | 查看历史会话并继续对话 |
| 上下文 | 上下文管理 | ⬜ | 控制历史长度、压缩较早的消息 |
| 配置 | 模型与参数配置 | ⬜ | 在配置文件或 REPL 中切换模型和推理强度 |
| CLI | `na` 命令入口 | ⬜ | 在任意项目目录启动 |
| 扩展 | 项目指令与自定义工具 | ⬜ | 加载项目说明并扩展工具能力 |

## 快速开始

开发环境：Node.js 22+、npm。

```bash
git clone git@github.com:markwwen/na.git
cd na
npm ci
```

配置模型服务：

```bash
export NA_BASE_URL="http://localhost:30000"
export NA_API_KEY="your-api-key"
```

将地址和密钥替换为实际配置。`NA_BASE_URL` 应为服务根地址，程序会追加 `/v1/messages`。

启动：

```bash
npm run dev
```

示例输入：

```text
查看当前目录下都有哪些文件

读取 package.json，告诉我这个项目如何启动

查看 src 目录，读取必要文件，解释 Agent 的工具调用循环
```

当前开发使用 SGLang 部署的 DeepSeek-V4.1-Flash，通过 Anthropic 兼容接口调用。服务端需要支持工具调用、thinking 和 SSE 流式响应。

## REPL 命令

| 命令 | 作用 |
|---|---|
| `/clear` | 开始新会话，保留旧会话文件 |
| `/quit` | 退出程序 |
| `Ctrl+C` | 任务执行中取消当前任务；空闲时退出程序 |

## 配置

| 配置项 | 位置 | 当前行为 |
|---|---|---|
| `NA_BASE_URL` | 环境变量 | 模型服务根地址，建议显式设置 |
| `NA_API_KEY` | 环境变量 | 必填的认证密钥 |
| 模型名称 | `src/main.ts` | 当前为 `deepseek`，应与服务端模型名称或别名对应 |
| `maxTokens` | `src/main.ts` | 当前为 `65536` |
| System 提示词 | `src/main.ts` | 常量 `SYSTEM_PROMPT`，定义 Agent 身份（na / 呐）与工作约束 |
| Thinking 配置 | `src/client.ts` | 当前显式开启 |
| 推理强度 | `src/client.ts` | 当前为 `output_config.effort: "max"` |

目前模型名称和推理参数需要修改代码，尚未提供 REPL 配置命令。

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
| `run_command` | `{"command":"npx tsc --noEmit -p src/tsconfig.json"}` | 通过 `/bin/sh` 执行非交互命令；默认超时 60 秒，最多 300 秒；stdout/stderr 各保留前 32 KiB；非零退出码或超时视为工具错误；仅支持 macOS / Linux |

路径以程序启动时的工作目录为基准。工具会解析真实路径，并检查目标是否位于工作目录内；`run_command` 的 `cwd` 同样受此限制。

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

每轮完成后，程序先写入临时文件，再替换会话文件。

当前只保存已完成的轮次。请求失败、流中断或保存失败时，本轮不会提交到内存历史；屏幕上可能已经显示部分内容。

重新启动会创建新会话，目前不会自动加载旧记录。

## 项目结构

```text
src/
├── main.ts         # REPL、配置与模块连接
├── agent.ts        # 对话状态与工具调用循环
├── client.ts       # 模型 HTTP 请求
├── stream.ts       # SSE 解析与完整消息拼接
├── renderer.ts     # 流式终端显示与 thinking 样式
├── tools.ts        # 工具定义、注册与执行
├── file-tools.ts   # write_file 与 edit_file
├── command-tool.ts # run_command
├── control.ts      # 取消、超时与可中断等待
├── session.ts      # 会话创建与 JSON 保存
├── types.ts        # 消息、工具及事件类型
└── tsconfig.json
```

## 开发

运行类型检查：

```bash
npx tsc --noEmit -p src/tsconfig.json
```

启动开发版本：

```bash
npm run dev
```