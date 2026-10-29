# 把 Claude Code 和 Cursor 变成 ACP Server：要做什么、现成包有哪些、它们怎么实现

> 取证环境：本机（macOS，2026-10-29）。所有"社区包怎么实现"的结论来自**实际读源码**，不是二手转述：
> - `@agentclientprotocol/claude-agent-acp@0.97.0`（全局安装，`dist/` 2.7 MB，`acp-agent.js` 11,101 行）
> - `@agentclientprotocol/codex-acp@2.3.0`（全局安装，作为"包 CLI 型"对照）
> - `claude` CLI 2.1.300（`claude --help | grep -i acp` → 0 命中，确认无原生 ACP）
> - Cursor 官方文档 `cursor.com/docs/cli/acp`（原文抓取）
> - `@agentclientprotocol/sdk@1.4.0` 的 schema（协议侧口径）

---

## 0. 一句话结论

| 目标 | 现状 | 你要做的工作 |
| --- | --- | --- |
| **Cursor → ACP Server** | **已经原生支持**：`agent acp` | 基本不写代码。配置 + 客户端侧适配 5 个 `cursor/*` 扩展方法 |
| **Claude Code → ACP Server** | **没有原生支持**（CLI 里 0 处 ACP 字样） | 必须写适配器。要么直接用官方适配器，要么自己写（两条技术路线，成本差 3~5 倍） |

这个差异是本篇最重要的信息：**这两个需求不在同一个工作量级上**。凡是把两者并列说"都要做适配器"的资料，基本是没实测过。

---

## 1. 先分清四种"变成 ACP Server"的路线

社区里所有方案，本质是这四类的组合。**成本从 0 到数月**，选错路线会白干：

| # | 路线 | 谁在用 | 成本 | 前提 |
| --- | --- | --- | --- | --- |
| **A** | **原生内置**：产品自己提供 `xxx acp` | Cursor（`agent acp`） | 0（你做客户端） | 厂商愿意做 |
| **B** | **进程内 SDK**：在你的进程里直接调 agent 的 SDK | `claude-agent-acp`（用 `@anthropic-ai/claude-agent-sdk`） | 中 | 该 agent 有**公开 SDK** |
| **C** | **spawn CLI + 走它自带的结构化 RPC** | `codex-acp`（spawn `codex app-server`，走 `vscode-jsonrpc`） | 中 | 该 CLI 有 **app-server / 机器可读协议** |
| **D** | **spawn CLI + 解析 stdout 的 stream-json** | 大量早期/民间适配器 | 低起步、高维护 | CLI 有 `--output-format stream-json` 之类 |

判断口径很简单，按顺序问：

```
产品自带 `xxx acp`？        → 走 A，别写适配器
有官方 SDK（进程内可调）？   → 走 B（最稳）
有 app-server / JSON-RPC？  → 走 C（次稳）
只有 stream-json 输出？     → 走 D（能跑，但每次升级都可能崩）
```

**Claude Code 落在 B 或 D；Cursor 落在 A。**

---

## 2. Case A：Cursor —— 已经不用做了

### 2.1 官方已经内置

Cursor CLI 直接提供 ACP 模式（官方文档原文）：

```bash
agent acp          # 以 ACP server 身份启动，stdio + NDJSON + JSON-RPC 2.0
agent --api-key "$CURSOR_API_KEY" acp
agent -e https://api2.cursor.sh acp
agent -k acp       # 跳过 TLS 校验（内网/自签证书）
```

传输、报文格式与我们在协议文档里说的一致：**stdio、一行一条 JSON、client 写 stdin、server 写 stdout、日志走 stderr**。

### 2.2 它实现了哪些 ACP 面

| 面 | Cursor 的实现 |
| --- | --- |
| 握手 | `initialize` → 暴露 auth method **`cursor_login`** |
| 认证 | `authenticate {methodId:"cursor_login"}`；也可预认证：`agent login` / `--api-key` / `CURSOR_API_KEY` / `--auth-token` / `CURSOR_AUTH_TOKEN` |
| 会话 | `session/new`、`session/load`（恢复历史对话） |
| 模式 | `agent`（全工具）/ `plan`（规划、只读）/ `ask`（问答、只读）—— 走 `modes` |
| 权限 | `session/request_permission`，选项是 **`allow-once` / `allow-always` / `reject-once`** |
| MCP | 读项目级/用户级 `.cursor/mcp.json`；**team 级（Dashboard 配的）在 ACP 模式不支持** |

### 2.3 真正的坑在这里：`cursor/*` 扩展方法

Cursor 不是"标准 ACP 就够"，它额外发了 5 个扩展方法。**不处理它们，体验会明显残缺**（尤其是计划审批和多选题）：

| 方法 | 类型 | 用途 | 不实现的后果 |
| --- | --- | --- | --- |
| `cursor/ask_question` | **阻塞**（agent 等你应答） | 多选题追问用户 | agent 卡住 / 超时失败 |
| `cursor/create_plan` | **阻塞** | 请求计划审批（带 `plan` markdown + `todos`） | Plan 模式基本不可用 |
| `cursor/update_todos` | 通知 | todo 状态变更 | 看不到任务进度 |
| `cursor/task` | 通知 | 子 agent 任务完成 | 子任务静默消失 |
| `cursor/generate_image` | 通知 | 生成的图片输出 | 图片不显示 |

两个阻塞方法的应答结构（官方文档给的类型）：

```ts
// cursor/ask_question 的应答
{ outcome: { outcome: "answered",
             answers: [{ questionId: "q1", selectedOptionIds: ["agent"] }] } }
// 或
{ outcome: { outcome: "skipped", reason?: string } }
{ outcome: { outcome: "cancelled" } }

// cursor/create_plan 的应答
{ outcome: { outcome: "accepted", planUri?: string } }
{ outcome: { outcome: "rejected", reason?: string } }
{ outcome: { outcome: "cancelled" } }
```

**注意**：这不违反 ACP。ACP 明确定义了"扩展方法"机制（自定义前缀 + 能力协商 + 未知方法要能优雅处理）。但反过来讲——**一个只实现标准 ACP 的客户端连 Cursor，会在 Plan 模式和提问环节露馅**。做宿主时这 5 个方法属于"必做"，不是"可选优化"。

### 2.4 所以你的实际工作量

1. 安装 Cursor CLI（`curl https://cursor.com/install -fsS | bash`），确认 `agent` 在 PATH。
2. 在宿主里注册一个 ACP agent 条目：`command: "agent", args: ["acp"]`。
3. 客户端侧实现 `cursor/ask_question`、`cursor/create_plan` 的阻塞应答 + 3 个通知的渲染。
4. 处理 `cursor_login` 的登录引导。
5. 想清楚 `.cursor/mcp.json` 与宿主自带 MCP 的冲突（谁优先、要不要禁用）。

**没有第 6 步。** 不需要写 server。

---

## 3. Case B：Claude Code —— 必须写适配器

### 3.1 先确认它真的没有原生 ACP

```bash
$ claude --help | grep -ci "acp\|agent-client-protocol"
0
```

`claude` 2.1.300 里没有 ACP 字样、没有 `acp` 子命令。它的机器可读接口是 **print 模式的 stream-json**：

```
--print, --output-format stream-json, --input-format stream-json,
--include-partial-messages, --permission-mode <mode>, --resume <session-id>
```

这就是路线 D 的入口，也是"为什么 Claude Code 需要适配器"的根因：**它把自己定位成终端产品，不是协议服务端。**

### 3.2 现成包：官方适配器（路线 B，推荐直接用）

```
npm i -g @agentclientprotocol/claude-agent-acp     # bin: claude-agent-acp
```

实测元数据（本机 0.97.0；npm 上已到 0.99.0）：

| 项 | 值 |
| --- | --- |
| 包名 | `@agentclientprotocol/claude-agent-acp`（**官方组织下**，不是野包） |
| 依赖 | `@anthropic-ai/claude-agent-sdk@0.3.310`、`@agentclientprotocol/sdk@2.0.2`、`diff@9`、`zod@4` |
| 运行时 | Node >= 22 |
| 体积 | `dist/` 2.7 MB，`acp-agent.js` **11,101 行** |

这 11k 行就是"把 Claude Code 的完整语义翻译成 ACP"的真实成本。**这也直接回答了"要做哪些工作"——它列出来的每一项都是一个坑。**

### 3.3 它是怎么实现的（逐层拆）

#### ① 底座选择：不包 CLI，而是进程内调 SDK

```
ACP JSON-RPC ──► adapter 进程 ──► @anthropic-ai/claude-agent-sdk（同进程）
                                      └─► 模型 API / 本地工具
```

为什么不用 stream-json？因为 SDK 给了三样 CLI 文本流给不了的东西：

- **`canUseTool` 回调**：工具执行前的授权钩子 → 天然映射成 `session/request_permission`（不用去解析审批 JSON）。
- **结构化事件**：tool_use / tool_result / 结构化输出，而不是"带 system-reminder 的文本"。
- **session resume / 控制通道**：`/mcp reconnect`、模式切换这类控制指令能走 SDK 控制 API（Claude Code 在 SDK 模式下会拒绝某些斜杠命令，适配器得自己实现）。

#### ② 工具调用映射：一个工具一个 reporter

`dist/tool-calls/reporters/` 下按 Claude 的工具名一一对应，而不是一个万能函数：

| Claude 工具 | kind | title 生成方式 |
| --- | --- | --- |
| `Read` | `read` | `Read <相对路径> (起-止行)` + `locations:[{path,line}]` |
| `Bash` | `execute` | 直接用命令本身当 title |
| `Edit` / `Write` / `NotebookEdit` | `edit` | 路径 + 变更摘要，附 diff |
| `Grep` / `Glob` | `search` | 模式 + 范围 |
| `WebFetch` / `WebSearch` | `fetch` | URL / 查询词 |
| `Task`（子 agent） | —— | 转成**子会话**，不是普通工具 |
| `TodoWrite` / `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` | —— | 转成 `plan` 更新（`PlanToolReporter`） |
| `SendMessage` / `TaskStop` / `ListAgents` / `Monitor` | —— | 归为 agent 控制类 |

这一步看着机械，但**是"看起来像原生"和"看起来像日志"的分界线**：kind 选错，客户端图标和折叠行为就错；`locations` 不填，"跟随跳转"就没有。

#### ③ 权限桥：`canUseTool` → `session/request_permission`

关键细节（都写在源码注释里，说明是真踩过）：

- Claude Code 的 **`bypassPermissions` 在调用 `canUseTool` 之前就生效了** —— 适配器必须自己判断，不能指望回调被调用。
- 子 agent 的权限请求也会进同一个 `canUseTool`，要用 `agentID` 区分归属，否则审批会串到父会话上。
- `allow_always` 要落成**"持久效果"**（用 `_meta` 挂扩展），否则用户每轮都被问同一件事。
- 取消窗口内到达的权限请求要能撤回，不然会留下"永远等不到答案"的弹窗。

#### ④ 文件改动：优先发 **git patch**（AIR 扩展），不发全文

`dist/diff.js` 用 `diff` 包的 `structuredPatch` 在**运行前**算出这份精确 patch，让客户端能在 agent 动手之前就展示"将要改成什么"。约束写得很明确：

```
MAX_PATCH_FILE_BYTES  = 1 MiB        // 大文件不做 patch（要读文件、算 diff，都在等审批的关键路径上）
PATCH_DIFF_TIMEOUT_MS = 100          // 同步 diff 的时间预算 = 事件循环最长阻塞
PATCH_CONTEXT_LINES   = 3
BINARY_SNIFF_BYTES    = 8000         // 二进制拒绝
NO_NEWLINE_MARKER     = "\ No newline at end of file"
```

拒绝条件：文件不存在、过大、二进制、**CRLF**、`old_string` 不是唯一匹配（Claude 会归一化引号或直接失败）。拒绝时回退到标准 `diff` content，甚至只发改动本身。

**这是一个必须知道的取舍**：标准 ACP 的 `diff` content 是 `oldText`/`newText` 全文 —— 大文件传全文很贵。所以成熟的适配器会**用扩展承载紧凑 patch**，并声明能力位。你做客户端时如果不认这个扩展，就得保证回退路径也好看。

#### ⑤ 子 agent → 子会话（不是塞进父会话）

按 ACP 的 subagents RFD 实现：`Task`/`Agent` 调用被替换成一个**独立子会话**，父会话先发 `subagent_update` 通告（`running` / `requires_action` / `idle`），消息用 `recipientMessageId` / `senderMessageId` 双向链接。

这条是"前沿但值得抄"的：扁平化转发子 agent 文本，会让长任务瞬间淹没主对话；做成子会话才能折叠、能单独取消（`session/cancel` 指定子会话 id，只停那一个）。

#### ⑥ 会话与配置

- `loadSession: true` —— `session/load` 会**回放**历史（客户端必须能幂等重建 UI）。
- 模式：Claude Code 的 permission modes 映射成 ACP `modes`（也映射成 config option 的 `mode` 类别）。SDK 侧的取值是：

  | SDK `permissionMode` | 语义 | 是否走 `canUseTool` |
  | --- | --- | --- |
  | `default` | 危险操作才问 | 是 |
  | `acceptEdits` | 自动接受文件编辑 | 部分 |
  | `plan` | 只规划、不执行 | 视情况 |
  | `bypassPermissions` | 跳过所有检查（需配套 flag） | **否 —— 在回调之前就生效了** |
  | `dontAsk` | 不问，未预授权即拒绝 | 否 |
  | `auto` | 模型分类器决定，拿不准才问 | 是（部分） |

  这张表就是"为什么权限桥最容易出错"的来源：**四种模式里三种不会触发你的回调**，你得自己在别处兜住。
- 配置项：`model`、effort（`thought_level`）、以及一个 `ultracode` 开关。
- **v1 与 v2 同时服务**：`CLAUDE_AGENT_ACP_PROTOCOL=auto|v1|v2` 控制。v1 客户端给 v1，v2 客户端给 v2。

### 3.4 如果你要自己写：两条路，先选对

#### 路线 B（自己接 SDK）—— 推荐

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";

agent({ name: "my-claude-acp" })
  .onRequest("initialize", () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
  }))
  .onRequest("session/new", async ({ params }) => {
    // 一个 ACP 会话 ↔ 一个 SDK session（resumeId）
    return { sessionId: crypto.randomUUID() };
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const q = query({
      prompt: toText(params.prompt),
      options: {
        cwd: session.cwd,
        resume: session.sdkSessionId,           // ← 续聊靠这个
        permissionMode: "default",
        // ★ 关键桥：SDK 授权钩子 → ACP 审批。签名是 (toolName, input, {signal, suggestions})
        canUseTool: async (toolName, input, { suggestions }) => {
          const { outcome } = await client.request("session/request_permission", {
            sessionId: params.sessionId,
            toolCall: { toolCallId: crypto.randomUUID(), title: toolName,
                        kind: "other", status: "pending" },
            options: [
              { optionId: "allow_once",   name: "允许",     kind: "allow_once" },
              { optionId: "allow_always", name: "总是允许", kind: "allow_always" },
              { optionId: "reject_once",  name: "拒绝",     kind: "reject_once" },
            ],
          });
          if (outcome.outcome !== "selected") return { behavior: "deny", message: "用户取消" };
          if (outcome.optionId === "reject_once") return { behavior: "deny", message: "用户拒绝" };
          if (outcome.optionId === "allow_always") {
            // ★ "总是允许" 的正确写法：把 SDK 给的 suggestions 原样回传
            return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions };
          }
          return { behavior: "allow", updatedInput: input };
        },
      },
    });

    for await (const msg of q) {
      switch (msg.type) {
        case "assistant":   // → session/update agent_message_chunk
        case "stream_event": // → 增量 chunk
        case "result":      // → stopReason
      }
    }
    return { stopReason: "end_turn" };
  })
  .connect(ndJsonStream(process.stdout, process.stdin));
```

要点：**授权、取消、模式、resume 都有 SDK 钩子可用，不需要解析文本**。

#### 路线 D（包 CLI 的 stream-json）—— 能跑，但脆

```bash
claude --print --output-format stream-json --input-format stream-json \
       --include-partial-messages --permission-mode default --resume <id>
```

| 难点 | 现实 |
| --- | --- |
| 审批 | CLI 在流里输出的是**权限请求 JSON**，你要自己解析并回写 stdin；没有 `canUseTool` 这种干净钩子 |
| 结构化输出 | tool_result 常是"带 `<system-reminder>` 的文本"，得自己剥（官方适配器就是因为这个才不剥文本、改用 SDK 的结构化字段） |
| 会话恢复 | 得自己维护 `--resume` 的 session id 映射 |
| 版本漂移 | CLI 每次改输出格式就会崩，且没有协议承诺 |
| 子 agent | 只能看到"Task 工具 + 一大段文本"，做不成子会话 |

**结论**：路线 D 只适合"验证可行性 / 内部临时用"。要长期用，接 SDK。

### 3.5 那为什么还有一堆人写 D？

因为它**通用**：任何 CLI 只要能喷 JSON 行，30 行代码就能起个 demo。你会看到大量"X 的 ACP adapter"是这类——跑通 demo 容易，做到能天天用很难。判断一个适配器成色，看它有没有处理：审批、取消、diff、子 agent、resume。这五项缺三项以上，就是 demo。

---

## 4. 逐项工作清单（按优先级，给 Claude Code 这类"路线 B"用）

| 优先级 | 工作 | 关键点 | 粗略量级 |
| --- | --- | --- | --- |
| **P0** | 骨架：`initialize` / `session/new` / `session/prompt` / `session/cancel` / `session/update` 流 | prompt 是长请求；cancel 是通知；stdout 只跑协议 | 2~3 天 |
| **P0** | 工具调用映射 | 一工具一 reporter；kind/locations/title 别偷懒 | 3~5 天 |
| **P1** | 权限桥 | 四种 option kind；`allow_always` 要持久；子 agent 归属；bypass 模式不回调 | 3~7 天（坑最多） |
| **P1** | 文件改动展示 | 优先 `diff` content；大文件/二进制/CRLF 要降级 | 2~5 天 |
| **P2** | 会话生命周期 | `load` 回放要幂等；`resume` 不回放；`list` 分页 | 2~4 天 |
| **P2** | 配置项 | `mode` / `model` / `thought_level` 类别；`set_config_option` 要串行 | 2~3 天 |
| **P3** | MCP 注入 | 客户端给的 `mcpServers` 要真的挂上（stdio/http） | 1~3 天 |
| **P3** | 斜杠命令 / plan / usage / compaction | `available_commands_update`、`plan`、`usage_update` | 2~4 天 |
| **P4** | 硬化 | 背压、超大输出截断、断线重连、Windows 路径、多会话并发 | 持续 |

**合计**：能天天用的 v1 ≈ **3~5 周**（一个人的熟手工期）；要做到官方适配器那个完成度（子会话、扩展、v2、错误恢复）≈ **数月**，11k 行不是虚的。

---

## 5. 社区包盘点（附实现证据）

| 包 | 目标 | 路线 | 实现证据 | 适合谁 |
| --- | --- | --- | --- | --- |
| **`agent acp`**（Cursor CLI 内置） | Cursor | **A 原生** | 官方文档 `cursor.com/docs/cli/acp`：stdio/NDJSON、`cursor_login`、3 种 mode、3 种权限选项、5 个 `cursor/*` 扩展 | 所有人（别自己写） |
| **`@agentclientprotocol/claude-agent-acp`** | Claude Code | **B 进程内 SDK** | 依赖 `@anthropic-ai/claude-agent-sdk`；`canUseTool` 桥审批；`tool-calls/reporters/*` 一工具一映射；`diff.js` 发 git patch | 想要 Claude Code 立刻可用 |
| **`@agentclientprotocol/codex-acp`** | Codex | **C spawn + app-server RPC** | 依赖 `@openai/codex` + `vscode-jsonrpc` + `cross-spawn`；方法名 `thread/start`、`turn/start`、`item/started`、`item/completed` | 想学"包 CLI"的正确姿势 |
| `@yaonyan/droid-acp` | Factory Droid | C/D | npm 可见，未读源码 | 小众 |
| `pi-acp` | Pi Coding Agent | D | 同上 | 小众 |
| `acpx` | **不是 adapter**，是 ACP **客户端**（headless CLI） | — | — | 用来测你的 server |
| `@ai-sdk/harness-acp` | 通用 harness 适配 | B/C | 未读源码 | 抽象层玩法 |

> 官方 agent 列表在 `agentclientprotocol.com/get-started/agents`（该页正文是客户端渲染，抓不到纯文本，以站点为准）。

### 5.1 一个反直觉的事实

**"Claude Code 支持 ACP"这句话，指的从来不是 Anthropic 官方支持，而是"社区/官方组织写了个适配器"。** 本机验证：`claude --help` 里 0 处 ACP。而 Cursor 是**厂商自己**做的。

所以选型时的真实问题不是"哪个更好"，而是：

- Cursor 这种"厂商做了"的：**升级跟着厂商走**，但受它的扩展方法约束（你得实现 `cursor/*`）。
- Claude Code 这种"适配器做的"：**能力取决于适配器作者翻了多少**，升级跟着适配器走，Anthropic 改 SDK 就可能断。

---

## 6. 决策矩阵

| 你的场景 | 建议 |
| --- | --- |
| 我只想在宿主编排器里用 Cursor | 装 Cursor CLI，注册 `agent acp`，实现 5 个扩展方法。**不要写 server** |
| 我只想在宿主编排器里用 Claude Code | 装 `@agentclientprotocol/claude-agent-acp`，`command: claude-agent-acp`。需要 Node>=22 + 已登录的 Claude |
| 我要改 Claude 的行为（加自定义工具/改审批语义） | 自己走**路线 B**（接 SDK），fork 官方适配器当起点，别从零写 |
| 我有个自研 CLI agent，想接 ACP | 先问它有没有 SDK/app-server；都没有才走 stream-json（路线 D） |
| 我要在 IDE 里用**我自己的** agent | 写 ACP **server**（本篇） |
| 我要在**我的产品**里用别人的 agent | 写 ACP **client**（上一篇文档） |

---

## 7. 验收清单：怎么判断一个适配器"真的能用"

拿去测任何"X 的 ACP adapter"，逐条打勾。**这是本文最实用的一节。**

1. `initialize` 声称的能力，和实际行为一致吗？（说 `loadSession: true` 就必须真能回放）
2. 拒绝工具时，agent 是**优雅降级**（告诉模型被拒、换方案），还是整个会话崩？
3. `allow_always` 之后，下一轮还问吗？（问 = 没做持久效果）
4. `session/cancel` 之后，`session/prompt` 是否以 `stopReason: "cancelled"` 正常返回？进程还活着吗？
5. 编辑一个大文件（>1 MB）时，界面是卡死、还是优雅回退？
6. `session/load` 回放会不会造成**消息重复**？（客户端幂等 + server 只回放一次）
7. 子 agent 的审批，会不会串到父会话上？
8. 工具调用的 `kind` 合理吗？（`Read` 显示成 `other` = 没做映射）
9. 杀掉 agent 进程再发消息，是明确报错还是静默卡住？
10. 它能同时跑两个会话吗？（stdio 单连接多会话是被支持的）

---

## 8. 一句话回答三个问题

**Q：把 Claude Code 和 Cursor 变成 ACP Server 要做哪些工作？**
A：**Cursor 不用做**（`agent acp` 原生即用，只需在客户端实现它的 5 个扩展方法）。**Claude Code 必须写适配器**：P0 骨架 + 工具映射 + 权限桥 + 会话生命周期，熟手 3~5 周；要么直接用官方适配器。

**Q：社区有现成的包吗？**
A：有，而且都是官方组织 `@agentclientprotocol/*` 下的：`claude-agent-acp`（Claude Code）、`codex-acp`（Codex）。Cursor 干脆是厂商内置。

**Q：它们怎么实现的？**
A：三种真功夫——**进程内接 SDK**（Claude，靠 `canUseTool` 桥审批）、**spawn CLI 走 app-server 私有 RPC**（Codex，靠 `item/started`/`turn/start`）、**解析 stream-json 文本**（民间，脆）。判断成色只看五项：审批、取消、diff、子 agent、resume。

---

## 参考

- Cursor CLI ACP 官方文档：<https://cursor.com/docs/cli/acp>（`agent acp`、`cursor_login`、`cursor/*` 扩展方法）
- Claude 适配器源码（本机）：`$(npm root -g)/@agentclientprotocol/claude-agent-acp/dist/`
  - `acp-agent.js`（11k 行，会话与权限主逻辑）
  - `tool-calls/reporters/*`（一工具一映射）
  - `diff.js`（git patch 生成与降级条件）
- Codex 适配器源码（本机）：`$(npm root -g)/@agentclientprotocol/codex-acp/dist/index.js`（spawn `codex app-server`）
- Claude Agent SDK：<https://platform.claude.com/docs/en/agent-sdk/overview>
- ACP 官方站点与 agent 列表：<https://agentclientprotocol.com/get-started/agents>
- 协议细节（方法表、能力协商、v2 草案）：见同目录 `acp-protocol-guide.md`
