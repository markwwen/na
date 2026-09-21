# 项目验证入口

由 na /init 从项目文件静态提取；尚未执行任何命令。项目配置变化后手动更新本文件。
命令以初始化目录为工作目录；开始前查看脚本内容与环境依赖，避免把命令名称当成安全性保证。

## 命令

| 入口 | 命令 | 来源 |
|---|---|---|
| build | `npm run build` | package.json → scripts.build |
| typecheck | `npm run typecheck` | package.json → scripts.typecheck |
| test | `npm run test` | package.json → scripts.test |

## 目录导航

- `assets/`
- `docs/`
- `examples/`
- `package-lock.json`
- `package.json`
- `README.md`
- `scripts/`
- `src/`
- `tests/`
- `tsconfig.json`

## 待确认

- README / CI 中的环境前提、项目用途和架构边界需要结合实际代码补充。
- 检查涉及部署、外部服务或持久化数据时，按本次任务授权确定执行范围。
