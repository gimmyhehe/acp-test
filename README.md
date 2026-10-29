# ACP Test

关于 **ACP（Agent Client Protocol）** 的笔记、对比分析，以及一个可运行的 ACP client demo。

ACP 是编辑器/宿主（client）与编码 agent（server）之间的标准协议：JSON-RPC 2.0，默认走 stdio，
支持能力协商、流式更新、工具调用、diff、审批，以及 agent 反向请求宿主的能力（读文件、跑命令）。

> 不是 Google 的 A2A，也不是 IBM 的 Agent Communication Protocol——只是缩写撞了。区别见第 3 篇。

## 文档

| # | 文档 | 内容 |
| --- | --- | --- |
| 1 | [acp-protocol-guide.md](acp-protocol-guide.md) | **协议详解**：N×M 集成问题、角色、传输、方法全景、会话生命周期、ContentBlock、工具调用与 diff、信任边界、MCP 复用、扩展机制、v2 草案变化、常见坑 |
| 2 | [acp-claude-cursor-server.md](acp-claude-cursor-server.md) | **把 Claude Code / Cursor 变成 ACP server**：四种适配策略、Cursor 原生 `agent acp`、Claude 适配器源码级拆解、工作清单、社区包盘点 |
| 3 | [acp-vs-a2a-and-dsh-subagents.md](acp-vs-a2a-and-dsh-subagents.md) | **ACP vs A2A vs 子 Agent**：三根轴的区别、子 agent 的三种落法、DSH 官方子 agent 插件的源码级分析 |
| 4 | [acp-reverse-calls.md](acp-reverse-calls.md) | **反向调用**：`fs/*`、`terminal/*`、`session/request_permission`、`elicitation/*`，以及"让 agent 读 skill"实际怎么实现（附实测抓包） |

配图在 [docs/acp-diagrams/](docs/acp-diagrams/)，全部是按 ACP v1 schema 和实测报文自绘的
（官方文档目前没有任何架构图）。

## Demo

[acp-client-demo/](acp-client-demo/) 是一个**零依赖**的 ACP client，实现在 agent 反向调用时会用到的全部能力：

```bash
cd acp-client-demo

# 离线验证：不需要账号、不花钱
node client.mjs --agent "node mock-agent.mjs" --prompt "测试反向调用"

# 连真实 Claude Code（需先安装 claude-agent-acp 并登录）
node client.mjs --prompt "请使用 demo-tools 的 read_skill 工具（name=greeting）读取技能并照做"

# 验证审批链路（默认模式是 auto，会自动批准，必须切 default 才问）
node client.mjs --mode default --prompt "用 Write 工具把 ACP-TEST 写入 /tmp/x.txt"
```

详见 [acp-client-demo/README.md](acp-client-demo/README.md)。

## 环境

- Node.js ≥ 22（demo 只用标准库）
- 可选：[`claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) 或 Cursor 的 `agent` CLI，用来跑真实 agent

## 许可

文档与 demo 代码均为示例用途，可自由取用。文中引用的协议规范归各自项目所有。
