# ACP client demo：反向调用

一个零依赖的 ACP client，实现 agent 能反向调用的全部能力（`fs/*`、`terminal/*`、`session/request_permission`、`elicitation/create`），
外加一个教学用 mock agent 和一个最小 MCP server。

配套文档：`../acp-reverse-calls.md`

## 跑起来

```bash
# 1. 离线验证（不需要账号、不花钱）：检查反向调用实现是否正确
node client.mjs --agent "node mock-agent.mjs" --prompt "测试反向调用"

# 2. 连真实 Claude Code：验证 MCP 工具反向调用
node client.mjs --prompt "请使用 demo-tools 的 read_skill 工具（name=greeting）读取技能并照做"

# 3. 连真实 Claude Code：验证审批反向调用
#    注意：默认模式是 auto，会自动批准、根本不会问你，所以必须切 default
node client.mjs --mode default --prompt "用 Write 工具把 ACP-TEST 写入 /tmp/x.txt"
```

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--agent` | `claude-agent-acp` | 任意 ACP agent 启动命令 |
| `--prompt` | `用一句话介绍你自己` | 本轮输入 |
| `--cwd` | 当前目录 | 会话工作目录（要绝对路径） |
| `--mode` | 空 | 建会话后切模式，如 `default` / `plan` / `acceptEdits` |
| `--approve` | `allow_once` | 审批策略：`allow_once` / `allow_always` / `reject_once` |
| `--no-mcp` | 关 | 不注入 demo MCP server |
| `--trace` | 空 | 把全部报文写成 JSONL（排障用） |
| `--timeout` | 180000 | 超时毫秒 |

## 文件

| 文件 | 作用 |
| --- | --- |
| `stdio-rpc.mjs` | NDJSON JSON-RPC 双工通道（未知请求回 `-32601`） |
| `client.mjs` | ACP client：能力声明 + 4 类反向方法 + 对话驱动 |
| `mock-agent.mjs` | 教学用 agent：把每种反向调用都调一遍 |
| `mcp-server.mjs` | 最小 MCP server：`read_skill` / `list_skills` / `host_info` |
| `skills/greeting.md` | 示例技能（验证码 `ACP-REVERSE-OK-2026`） |

## 抓包

`trace-*.jsonl` 是 `--trace` 生成的报文，每行 `{t, dir, msg}`。
（这些文件不入库：抓包里含本机内网网关信息，跑一次就会自己生成。）


```bash
jq -c 'select(.dir=="in") | .msg | select(.method)' trace-claude-perm.jsonl
```
