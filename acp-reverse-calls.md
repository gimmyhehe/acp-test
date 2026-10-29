# ACP 的反向调用：agent 怎么反过来用宿主的能力

> 实测环境：macOS / Node 22.18 / `@agentclientprotocol/claude-agent-acp@0.97.0` / Claude Code 2.1.300（已登录）。
> 本文所有报文都是**真实抓包**（本地跑 `--trace` 生成，抓包含内网网关信息、不入库），配套代码在 `acp-client-demo/`，可直接跑。
> 结论先行：**ACP 里没有"skill"这个协议概念**；"读 skill"、"调工具"是两类不同机制，见第 2、5 节。

---

## 1. 为什么需要反向调用

正向链路是宿主驱动 agent：`initialize → session/new → session/prompt → session/update`。

但 agent 干活时需要三样东西只有宿主才有：

| 需要什么 | 为什么 agent 自己做不到 | ACP 的通道 |
| --- | --- | --- |
| **用户的可信视野** | 文件真实来源可能是未保存的 buffer；命令要跑在用户看得见的终端里 | `fs/*`、`terminal/*` |
| **人的授权** | 改文件、跑命令要不要批准，只能人决定 | `session/request_permission` |
| **人的输入** | 追问、表单、OAuth 登录 | `elicitation/create` |

**机制上没有任何魔法**：它是**同一条 stdio 连接上的双向 JSON-RPC**。方向不靠连接区分，靠**方法名归属**区分：

```
client → agent : initialize / session/new / session/prompt / session/cancel / session/set_mode …
agent → client : fs/* / terminal/* / session/request_permission / session/update / elicitation/* …
```

所以写 client 时第一件事就是建两张表：哪些方法是我发的，哪些是我要**应答**的。

---

## 2. 先纠正一个概念：ACP 没有 "skill"

我翻了 `@agentclientprotocol/sdk` 的完整 schema（265 个定义）：**没有 skill 相关的方法、类型或字段**。有 `document/*`（编辑器文档状态，实验）、有 `providers/*`（模型供应商），但没有 skill。

那"让 agent 读技能"实际怎么落地？只有两条路，而且都不在 ACP 层：

| 落地方式 | 方法 | 谁提供 | 适用 |
| --- | --- | --- | --- |
| **当文件给** | `fs/read_text_file` | client 实现 | 技能是磁盘上的 `.md`，且 agent 没有自己的文件工具 |
| **当工具给** | `session/new` 的 `mcpServers` → MCP `tools/call` | client 起一个 MCP server | 技能需要权限、需要动态生成、或 agent 自带文件工具（**实测 Claude 走这条**） |

**关键区别**：

- `fs/*` 是 ACP 的反向调用，报文在 ACP 连接里。
- MCP 工具**不在 ACP 连接里**：agent 自己 spawn 那个 MCP server（stdio）或直连 URL（http），ACP 只负责在 `session/new` 里**把地址传过去**。

我把两条都实现了，实测见第 6 节。

---

## 3. 反向调用的四条通道（逐条拆）

### 3.1 `fs/read_text_file` / `fs/write_text_file`

```json
{"jsonrpc":"2.0","id":3,"method":"fs/read_text_file",
 "params":{"sessionId":"s1","path":"/abs/path/client.mjs","line":1,"limit":400}}
```
```json
{"jsonrpc":"2.0","id":3,"result":{"content":"…文件内容…"}}
```

要点：
- **能力门**：client 必须在 `initialize` 里声明 `clientCapabilities.fs.readTextFile / writeTextFile`，否则 agent 不该调。
- **`line` 是 1-based**，`limit` 是行数；两个都不给就是全文。
- **语义是"给我文件内容"，不是"给我磁盘内容"**。成熟宿主的实现是"先查编辑器 buffer，没有才读盘"——这就是为什么协议要绕一圈让 client 读：**编辑器里未保存的改动，agent 才看得到**。
- 写文件同理：宿主可以先写进 buffer 等用户确认，而不是直接落盘。

### 3.2 `terminal/*`（5 个方法，一套小生命周期）

```
terminal/create  → { terminalId }
terminal/output  → { output, truncated, exitStatus? }
terminal/wait_for_exit → { exitCode, signal }
terminal/kill    → {}
terminal/release → {}
```

`create` 的参数：`command`、`args`、`env:[{name,value}]`、`cwd`（绝对路径）、`outputByteLimit`。

要点：
- **`outputByteLimit` 是 agent 指定的**，client 超过就要截断（从头部截），并置 `truncated: true`。不截断会把上下文撑爆。
- `output` 里 stdout/stderr 是**混合**的，协议不区分。
- `wait_for_exit` 与 `output` 是分开的：agent 可以先轮询输出看进度，再等退出。
- **`release` 必须释放资源**（杀进程、关管道），不然宿主会漏进程——这是一个很常见的泄漏点。
- 为什么绕这么一圈：命令跑在**宿主的终端**里，用户能看见、能接管、能中断。agent 不直接 exec。

### 3.3 `session/request_permission`（最重要的一个）

真实抓包（Claude 要写文件时发来的）：

```json
{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{
  "toolCall":{
    "toolCallId":"call_00_pa4qz5i2komcdxlmx1bkne33",
    "name":"Write","title":"Write /tmp/acp-demo-out2.txt","kind":"edit","status":"pending",
    "content":[{"type":"diff","path":"/tmp/acp-demo-out2.txt",
                "oldText":null,"newText":"ACP-PERMISSION-TEST\n"}],
    "locations":[{"path":"/tmp/acp-demo-out2.txt"}],
    "rawInput":{"file_path":"/tmp/acp-demo-out2.txt","content":"ACP-PERMISSION-TEST\n"}
  },
  "options":[
    {"optionId":"allow-once","name":"Yes","kind":"allow_once"},
    {"optionId":"allow-with-updates","name":"Yes, allow all edits in tmp/ during this session","kind":"allow_always"},
    {"optionId":"reject","name":"No","kind":"reject_once"}
  ]}}
```

应答只有两种形态：

```json
{"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}
{"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"cancelled"}}}
```

要点（这几条都是踩过坑才写得出来的）：

- **选项是 agent 生成的，名字也是它起的**。上面那个 `allow-with-updates` 是 Claude 适配器自己算出来的"tmp/ 目录本次会话都允许"。client 不该猜语义，只该展示 + 回 `optionId`。
- **`kind` 只是 UI 提示**（`allow_once` / `allow_always` / `reject_once` / `reject_always`），不是 client 可以自行决定的语义。
- **`allow_always` 需要"持久效果"**：适配器会在下一次把它变成"不再问"。这就是 SDK 里 `updatedPermissions: suggestions` 的作用（见上一篇文档）。
- **`cancelled` ≠ `reject`**：前者是"用户没答/被打断"，后者是明确拒绝。混用会让 agent 做错决策（重试 vs 换方案）。
- **打不开的审批会卡死整个会话**。client 必须保证：要么回 `selected`，要么回 `cancelled`，**永远不要不回**。

### 3.4 `elicitation/create`（比权限更通用的"要人输入"）

```json
{"jsonrpc":"2.0","id":"e1","method":"elicitation/create","params":{
  "sessionId":"s1","mode":"form","message":"选择部署环境",
  "requestedSchema":{"type":"object","properties":{"env":{"type":"string","enum":["staging","prod"]}},"required":["env"]}}}
```
```json
{"jsonrpc":"2.0","id":"e1","result":{"action":"accept","content":{"env":"staging"}}}
{"jsonrpc":"2.0","id":"e1","result":{"action":"decline"}}
{"jsonrpc":"2.0","id":"e1","result":{"action":"cancel"}}
```

要点：
- 两种 `mode`：`form`（JSON Schema 表单）与 `url`（把用户导到一个 URL，比如 OAuth）。留了 `_` 前缀给自定义 mode。
- **`accept` 才带 `content`**；`decline`（用户不想提供）/ `cancel`（被打断）都不带。
- 这是"标准化后的 `cursor/ask_question`"。**先实现这个，再考虑给 Cursor 写方言适配**。

### 3.5 附：`mcp/*`（实验）

`mcp/connect`、`mcp/message`、`mcp/disconnect` 让 agent 通过 ACP 隧道和 **client 侧的 MCP server** 通信（对应 `mcpServers` 里 `type:"acp"`）。目前 `claude-agent-acp` 只声明了 `mcpCapabilities: {http, sse}`，不支持 `acp`，所以这条路暂时没有生产实现可参考。

---

## 4. 三条通道的对比（别混）

| | `fs/*` / `terminal/*` | `session/request_permission` | `mcpServers` + MCP |
| --- | --- | --- | --- |
| 谁调用谁 | agent → client（走 ACP） | agent → client（走 ACP） | agent → MCP server（**不走 ACP**） |
| 传的是 | 能力 | 授权 | 工具 |
| client 要做 | 实现方法 | 实现方法 | 起一个 MCP server 并传地址 |
| 典型用途 | 读未保存 buffer、跑可见命令 | 危险操作前问人 | 提供业务工具（含 skill 读取） |

一句话：**能力走 ACP，工具走 MCP，授权走 ACP。** 三者都会让 agent"反向"用到宿主，但只有前两个在 ACP 连接里。

---

## 5. 实测：我写的 client + 真实 Claude Code

### 5.1 代码结构（`acp-client-demo/`）

| 文件 | 职责 | 行数 |
| --- | --- | --- |
| `stdio-rpc.mjs` | NDJSON JSON-RPC 双工：请求/通知/响应分发，未知方法回 `-32601` | 77 |
| `client.mjs` | **ACP client 主体**：声明能力、实现 4 类反向方法、驱动一轮对话、统计反向调用 | 258 |
| `mock-agent.mjs` | 教学用 ACP agent：故意把每种反向调用都调一遍（不花钱、不需要账号） | 114 |
| `mcp-server.mjs` | 最小 MCP server（零依赖）：`read_skill` / `list_skills` / `host_info` | 89 |
| `skills/greeting.md` | 示例技能文件 | — |

### 5.2 用 mock agent 验证协议正确性（不花钱）

```bash
cd acp-client-demo
node client.mjs --agent "node mock-agent.mjs" --prompt "测试反向调用"
```

真实输出：

```
① fs/read_text_file ✅ 读到了 9644 字符（…/client.mjs）
② terminal/* ✅ 退出码 0，输出：hello from darwin
③ session/request_permission ✅ 宿主裁决：批准（allow_once）
④ plan 上报 ✅（宿主应能渲染成 todo 列表）

这一轮里 agent 反向调用了 client 的能力：
  fs/read_text_file  ×1
  terminal/create  ×1
  terminal/wait_for_exit  ×1
  terminal/output  ×1
  terminal/release  ×1
  session/request_permission  ×1
```

**这一步的意义**：反向调用的正确性可以完全离线验证。写 client 时先用 mock agent 跑通，再去连真 agent——否则两边都是黑盒，出问题根本分不清是谁的锅。

### 5.3 连真实 Claude Code

```bash
node client.mjs --prompt "请使用 demo-tools 这个 MCP server 提供的 read_skill 工具（参数 name=greeting）读取技能，并严格照做。"
```

结果（真实）：

```
我是通过宿主的 MCP 工具 `read_skill` 读到这份文件的。

**ACP-REVERSE-OK-2026**
```

验证码对上了，说明 **agent 确实反向调用了 client 提供的 MCP 工具**（`mcp__demo-tools__read_skill` 出现在 `tool_call` 更新里，带 `_meta.claudeCode.toolName`）。

### 5.4 四个必须知道的实测发现

**发现 1：`fs/*` 和 `terminal/*` 一次都没被调用（计数为 0）。**

不是我的 client 写错了——是 **Claude Code 自带文件与 Bash 工具，它自己读盘、自己 exec**。ACP 的 `fs/*`/`terminal/*` 是给"没有自己工具的 agent"用的。所以：

> **别指望接了 ACP 就能审 Claude 的每一次读文件/跑命令。** 真正能卡住的只有它愿意问的那部分（审批）。

这也解释了为什么"用 ACP 做安全沙箱"是幻觉：**协议没有强制力**。

**发现 2：默认根本收不到审批——因为会话默认模式是 `auto`。**

抓包显示 `session/new` 返回 `modes.currentModeId = "auto"`（分类器自动批准），于是写文件**不问人**。切成 `default` 才收到 `request_permission`：

```bash
node client.mjs --mode default --prompt "用 Write 工具把 X 写入 /tmp/y.txt"
```

```
[← agent] session/request_permission  工具: Write /tmp/acp-demo-out2.txt (kind=edit)
    · allow-once  Yes  [allow_once]
    · allow-with-updates  Yes, allow all edits in tmp/ during this session  [allow_always]
    · reject  No  [reject_once]
```

> **坑**：client 想验审批，必须显式 `session/set_mode` 切到会问人的模式。很多"我的审批收不到"的 bug 都源于此。

**发现 3：`allow_always` 的文案是 agent 算出来的**。

"allow all edits in tmp/ during this session" 不是 client 生成的，是适配器根据 SDK 给的 suggestions 拼的。client 老老实实把 `optionId` 回传即可。

**发现 4：会遇到不认识的扩展通知，必须能忽略。**

真实日志里出现了 `_auth/status_update`（Claude 适配器的 `_auth/` 扩展）。我的 client 打了一行日志就略过——**这是正确做法**。未知**通知**丢弃，未知**请求**回 `-32601`，两条规则就够。

---

## 6. 一个最小 client 必须实现的清单

写 client 时照着打勾：

**协议层**
- [ ] NDJSON 分帧（一行一条 JSON，注意 `\r\n` 也要容忍）
- [ ] 双向分发：由 `method` 判断"这是我要应答的请求"还是"对方的通知"
- [ ] 未知**请求** → 回 `-32601`（否则对方永久阻塞）
- [ ] 未知**通知** → 丢弃 + 打点，绝不抛错
- [ ] 所有出站请求都要有超时，且能被 `$/cancel_request` 打断

**能力层**
- [ ] `fs/read_text_file` 支持 `line`/`limit`（1-based）
- [ ] `fs/write_text_file` 落盘前考虑"是否要经用户确认"
- [ ] `terminal/create` 保存句柄；`output` 按 `outputByteLimit` 从头部截断并置 `truncated`
- [ ] `terminal/wait_for_exit` 与 `output` 解耦（不要合成一个）
- [ ] `terminal/release` 真的杀进程 + 删表（防僵尸进程）
- [ ] `session/request_permission`：展示 agent 给的选项，回 `optionId`；用户关闭弹窗 → 回 `cancelled`
- [ ] `elicitation/create`：`accept` 带 `content`，`decline`/`cancel` 不带

**会话层**
- [ ] `session/update` 按 `sessionUpdate` 分派渲染，未知类型忽略
- [ ] `session/set_mode` 能切模式（否则审批收不到）
- [ ] `session/cancel` 是**通知**不是请求，别等回包
- [ ] 记住 `sessionId`，多会话时按 sessionId 隔离状态

---

## 7. 复现步骤

```bash
cd acp-client-demo

# 1) 离线验证（不花钱）：看反向调用是否都实现对了
node client.mjs --agent "node mock-agent.mjs" --prompt "测试反向调用"

# 2) 真实 Claude：验证 MCP 工具反向调用
node client.mjs --trace trace-mcp.jsonl \
  --prompt "请使用 demo-tools 的 read_skill 工具（name=greeting）读取技能并照做"

# 3) 真实 Claude：验证审批反向调用（关键：先切 default 模式）
node client.mjs --mode default --trace trace-perm.jsonl \
  --prompt "用 Write 工具把 ACP-TEST 写入 /tmp/x.txt"

# 4) 看完整报文
jq -c 'select(.dir=="in") | .msg | select(.method)' trace-perm.jsonl
```

参数：`--agent`（任意 ACP agent 命令）、`--mode`（会话模式）、`--approve`（审批策略）、`--no-mcp`、`--trace`、`--timeout`。

`--trace` 产出的是 JSONL，每条带方向、时间戳和完整报文——**排障时这个文件比日志有用得多**（能看清是"没发"还是"发了没回"）。

---

## 8. 安全提醒

反向调用本质是**你把能力交给了一个外部进程**：

1. `fs/write_text_file` 一旦实现成无条件落盘，agent 就获得了任意写权限。
2. `terminal/create` 一旦实现成直接 spawn，agent 就获得了任意命令执行——**AT 就是本机 shell**。
3. `session/request_permission` 可以被 client 自动批准（`--approve allow_always`），等于关掉唯一的闸门。
4. 而且第 5.4 节的发现 1 说明：**不管你怎么限制，自带工具的 agent 根本不受你约束**。

所以正确的定位是：**ACP 是"体验协议"，不是"安全边界"**。要真隔离，靠容器/沙箱/权限系统，别靠协议。

---

## 参考

- 本文代码：`acp-client-demo/`（`client.mjs`、`mock-agent.mjs`、`mcp-server.mjs`）
- 真实抓包：用 `--trace <file>.jsonl` 自行生成（仓库不收录：含本机网关地址与会话 id）
- 协议方法表与能力协商：`acp-protocol-guide.md`
- 适配器实现分析：`acp-claude-cursor-server.md`
- ACP 规范：<https://agentclientprotocol.com>
