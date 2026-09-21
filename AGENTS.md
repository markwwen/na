# na — 项目开发指南

na（呐）是从零实现的轻量级终端 Coding Agent，用于逐步学习和构建模型调用、工具执行、会话与上下文管理。采用 TypeScript、Node.js 22+ 和 ESM；目前只实现 Anthropic Messages 兼容协议，直接使用 `fetch` 和 SSE，没有依赖 Agent 框架。命令执行工具面向 macOS / Linux。

## 按任务定位代码

| 修改方向 | 入口与职责 |
|---|---|
| CLI、REPL、交互 | [cli.ts](src/cli.ts) 解析启动参数；[main.ts](src/main.ts) 处理命令、组装 Agent、取消与退出；[renderer.ts](src/renderer.ts) 显示流式内容 |
| Agent 循环 | [agent.ts](src/agent.ts) 组织请求、执行工具、提交会话；[types.ts](src/types.ts) 定义消息和工具接口 |
| 模型与协议 | [env.ts](src/env.ts) 启动时加载项目环境变量；[config.ts](src/config.ts) 加载配置；[model.ts](src/model.ts) 生成请求参数和历史回放；[client.ts](src/client.ts) 请求与超时；[stream.ts](src/stream.ts) 校验 SSE 消息 |
| 工具与取消 | [tools.ts](src/tools.ts) 注册和分发工具；[file-tools.ts](src/file-tools.ts) 写入与精确替换；[command-tool.ts](src/command-tool.ts) 子进程管理；[control.ts](src/control.ts) 取消和超时类型 |
| 历史与上下文 | [history.ts](src/history.ts) 校验完整轮次；[session.ts](src/session.ts) 保存与恢复；[context.ts](src/context.ts) 生成摘要和请求上下文；[budget.ts](src/budget.ts) 估算 token、校准 usage 和预留输出空间 |
| 项目指导与 skills | [instructions.ts](src/instructions.ts) 加载项目指令；[skills.ts](src/skills.ts) 发现与按需读取；[init.ts](src/init.ts) 生成框架；[project-files.ts](src/project-files.ts) 有大小限制的文本读取 |

安装、配置和用户命令见 [README](README.md)。调整 harness 的范围和默认行为时，参考 [设计说明](docs/harness-design.md)；只读取本次任务相关的资料。

## 开发与验证

使用 npm 和仓库的 `package-lock.json`。首次安装运行 `npm ci`，其 `prepare` 脚本会自动构建。源码中的相对模块导入使用 `.js` 后缀，遵循根目录 `tsconfig.json` 的 NodeNext 配置。

| 命令 | 用途与范围 |
|---|---|
| `npm run dev -- <参数>` | 通过 tsx 启动源码版本；会使用当前配置，普通对话会请求模型 |
| `npm run typecheck` | 检查 `src/**/*.ts`，不生成文件；不包含 `tests/` 的静态类型检查 |
| `npm test` | 使用 Node 内置测试运行器和 tsx 执行 `tests/*.test.ts` |
| `npm run build` | 编译到 `dist/`；修改源码后，已通过 `npm link` 安装的 `na` 需要重新构建才能更新 |

当前测试主要覆盖 skills、初始化、指令加载和部分 Agent 集成。它们使用临时目录和模拟请求，不需要真实模型密钥；通过这些测试不代表所有协议、终端和进程行为都已验证。当前未配置 lint 脚本。

按改动选择验证：TypeScript 改动检查类型及相关测试；CLI 或打包改动验证构建后的入口；纯文档改动核对内容与链接即可。测试新行为时优先使用临时目录、模拟 fetch 或本地服务，避免依赖个人 `~/.na` 配置、真实会话和远端模型。需要专项验证流程时可使用 [verify-project](.agents/skills/verify-project/SKILL.md)。

## 修改时保持的行为

- **提交顺序：** 一轮对话使用临时历史，成功保存后才更新 Agent 内存状态；模型切换和环境重载也保持先保存后提交。取消或请求失败不能保存半轮消息；已发生的文件修改和命令副作用不会自动回滚。
- **消息配对：** 等完整模型消息解析成功后再执行工具。同一条 assistant 消息中的调用目前顺序执行，所有 `tool_result` 放入紧随其后的 user 消息，并按 `tool_use_id` 配对。普通工具错误回传给模型，用户取消向上抛出以停止当前轮次。
- **归档与请求分离：** 摘要只覆盖完整的早期轮次，完整历史仍保留。旧轮次的 thinking 可以在发送请求时过滤；当前工具调用链的 thinking 与签名保持完整，不修改归档原文。上下文同时检查字符上限与模型 token 窗口，并预留输出空间；usage 只校准匹配的请求前缀，不是精确 token 预计算。校准信息仅存内存，不写入会话。
- **取消与清理：** 沿调用链传递 `AbortSignal`。写文件和运行命令需要等待自身提交或清理完成，不能仅用 `abortable` 提前结束等待。每轮 REPL 的 finally 只清理本轮状态，readline 在整个输入循环结束时关闭。
- **工作目录：** `na` 操作的是用户启动目录，不是软件安装目录，也不会自动切到 Git 根目录。会话位于启动目录的 `.na/sessions/`。项目文件工具检查真实路径；skill 参考文件以对应 skill 目录为边界。`run_command` 对 cwd 的限制不是对 shell 本身的沙箱隔离。
- **配置与凭据：** 通过配置层解析模型、认证和 thinking，不在请求层写死服务地址或推理强度。`reasoning: true` 只声明能力，未指定强度时默认 `off`。会话中的模型选择只保存 provider、模型 ID 和强度，不序列化完整配置或凭据。
- **环境变量：** 启动时读取 cwd 的 `.env`，已有进程变量优先；在配置解析和 renderer 初始化前加载，子进程继承。`/reload` 不重读 `.env`，变更需重启；`ConfigCatalog.load()` 自身不修改进程环境。
- **渐进加载：** 常驻上下文包含项目指令和 skill 元数据；skill 正文、参考文件按需读取。`/reload` 保留当前模型与对话。`/init` 只创建缺失文件，不覆盖已有入口、不执行发现的命令，也不把静态发现写成验证成功。

## 变更范围

编辑 `src/`，通过构建更新生成的 `dist/`。修改用户可见的命令、配置或行为时同步更新 README；保持会话格式的兼容性，若确实需要破坏性变更，应明确迁移方式。

这个入口只保存稳定的项目事实和关键约束。专项流程放在 `.agents/skills/`，解释性设计放在 `docs/`；本次任务日志、临时测试结果和个人模型配置不写入这里。
