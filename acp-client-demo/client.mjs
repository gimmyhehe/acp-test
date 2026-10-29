#!/usr/bin/env node
// ACP 客户端：声明能力 → 实现 agent 能反向调用的全部方法 → 驱动一轮对话
//
// 用法：
//   node client.mjs --prompt "你好"                      # 连真实 claude-agent-acp
//   node client.mjs --agent "node mock-agent.mjs"        # 连教学用 mock agent
//   node client.mjs --trace trace.jsonl --prompt "..."   # 记录完整报文
//
// 这个文件就是"反向调用"的客户端一侧：agent 随时能反过来请求下面这些能力。
import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { createRpc } from "./stdio-rpc.mjs";

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const AGENT_CMD = arg("agent", "claude-agent-acp");
const PROMPT = arg("prompt", "用一句话介绍你自己");
const CWD = path.resolve(arg("cwd", process.cwd()));
const TRACE = arg("trace", "");
const APPROVE = arg("approve", "allow_once"); // allow_once | allow_always | reject_once
const MODE = arg("mode", "");                 // 空 = 用 agent 默认；如 default / plan / acceptEdits
const TIMEOUT_MS = Number(arg("timeout", "180000"));
const NO_MCP = flag("no-mcp");

const traceStream = TRACE ? createWriteStream(TRACE) : null;
const trace = (entry) => traceStream?.write(JSON.stringify({ t: Date.now(), ...entry }) + "\n");

// ---------- 统计：这一轮里 agent 反向调了什么 ----------
const reverseCalls = Object.create(null);
const bump = (m) => (reverseCalls[m] = (reverseCalls[m] ?? 0) + 1);
const log = (...a) => console.log(...a);

// ---------- 终端表：terminal/* 需要在 client 侧真的跑进程 ----------
const terminals = new Map();

// ---------- 启动 agent ----------
const [cmd, ...cmdArgs] = AGENT_CMD.split(" ");
const child = spawn(cmd, cmdArgs, {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});
child.stderr.on("data", (d) => process.stderr.write(`[agent] ${d}`));
child.on("exit", (code, sig) => {
  log(`\n[client] agent 退出 code=${code} signal=${sig}`);
  finish(code ?? 0);
});

const rpc = createRpc({
  input: child.stdout,
  output: child.stdin,
  onTrace: trace,
});

// ============================================================
// 反向调用 1/4：文件系统
// 只在 clientCapabilities.fs 里声明了才会被调用
// ============================================================
rpc.onRequest("fs/read_text_file", async ({ sessionId, path: p, line, limit }) => {
  bump("fs/read_text_file");
  log(`\n[← agent] fs/read_text_file  ${p}${line ? ` (from line ${line}, limit ${limit})` : ""}`);
  const raw = await readFile(p, "utf8");
  if (!line && !limit) return { content: raw };
  const lines = raw.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit ? start + limit : lines.length;
  return { content: lines.slice(start, end).join("\n") };
});

rpc.onRequest("fs/write_text_file", async ({ sessionId, path: p, content }) => {
  bump("fs/write_text_file");
  log(`\n[← agent] fs/write_text_file ${p} (${content?.length ?? 0} 字符)`);
  writeFileSync(p, content, "utf8");
  return {};
});

// ============================================================
// 反向调用 2/4：终端
// agent 不自己跑命令，而是让宿主跑 —— 用户可见、可接管、可审计
// ============================================================
rpc.onRequest("terminal/create", async ({ command, args = [], env = [], cwd, outputByteLimit }) => {
  bump("terminal/create");
  const id = `term_${terminals.size + 1}`;
  log(`\n[← agent] terminal/create ${id}: ${command} ${args.join(" ")}`);

  const envObj = { ...process.env };
  for (const e of env ?? []) envObj[e.name] = e.value;

  const proc = spawn(command, args, { cwd: cwd ?? CWD, env: envObj, stdio: ["ignore", "pipe", "pipe"] });
  const term = { id, proc, output: "", exitCode: null, signal: null, limit: outputByteLimit ?? 1 << 20 };
  const append = (buf) => {
    term.output += buf.toString();
    if (term.output.length > term.limit) term.output = term.output.slice(-term.limit); // 从头部截断
  };
  proc.stdout.on("data", append);
  proc.stderr.on("data", append);
  proc.on("exit", (code, sig) => { term.exitCode = code; term.signal = sig; term.done = true; });
  term.exited = new Promise((res) => proc.on("exit", res));
  terminals.set(id, term);
  return { terminalId: id };
});

rpc.onRequest("terminal/output", async ({ terminalId }) => {
  bump("terminal/output");
  const t = terminals.get(terminalId);
  if (!t) throw new Error(`unknown terminal ${terminalId}`);
  return {
    output: t.output,
    truncated: t.output.length >= t.limit,
    ...(t.done ? { exitStatus: { exitCode: t.exitCode, signal: t.signal } } : {}),
  };
});

rpc.onRequest("terminal/wait_for_exit", async ({ terminalId }) => {
  bump("terminal/wait_for_exit");
  const t = terminals.get(terminalId);
  if (!t) throw new Error(`unknown terminal ${terminalId}`);
  await t.exited;
  log(`[client] 终端 ${terminalId} 退出 code=${t.exitCode}`);
  return { exitCode: t.exitCode, signal: t.signal };
});

rpc.onRequest("terminal/kill", async ({ terminalId }) => {
  bump("terminal/kill");
  terminals.get(terminalId)?.proc.kill("SIGTERM");
  return {};
});

rpc.onRequest("terminal/release", async ({ terminalId }) => {
  bump("terminal/release");
  const t = terminals.get(terminalId);
  if (t && !t.done) t.proc.kill("SIGKILL");
  terminals.delete(terminalId);
  return {};
});

// ============================================================
// 反向调用 3/4：权限审批
// 这是"agent 请求宿主批准"的唯一正门
// ============================================================
rpc.onRequest("session/request_permission", async ({ sessionId, toolCall, options }) => {
  bump("session/request_permission");
  log(`\n[← agent] session/request_permission  工具: ${toolCall?.title ?? "?"} (kind=${toolCall?.kind ?? "?"})`);
  for (const o of options ?? []) log(`    · ${o.optionId}  ${o.name}  [${o.kind}]`);
  const picked = (options ?? []).find((o) => o.optionId === APPROVE) ?? options?.[0];
  if (!picked) return { outcome: { outcome: "cancelled" } };
  log(`[client] 决定: ${picked.optionId}`);
  return { outcome: { outcome: "selected", optionId: picked.optionId } };
});

// ============================================================
// 反向调用 4/4：结构化追问（比权限更通用的"要用户输入"）
// ============================================================
rpc.onRequest("elicitation/create", async ({ message, mode }) => {
  bump("elicitation/create");
  log(`\n[← agent] elicitation/create  mode=${mode}  ${message ?? ""}`);
  return { action: "decline" }; // 演示用：拒绝，让 agent 自己想办法
});

// ---------- 反向"通知"：会话流 ----------
rpc.onNotification("session/update", async ({ update }) => {
  const kind = update?.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const c = update.content;
    if (c?.type === "text") process.stdout.write(c.text);
  } else if (kind === "agent_thought_chunk") {
    const c = update.content;
    if (c?.type === "text") process.stdout.write(`\x1b[2m${c.text}\x1b[0m`);
  } else if (kind === "tool_call") {
    log(`\n[update] tool_call  ${update.title}  kind=${update.kind ?? "?"} status=${update.status ?? "?"}`);
  } else if (kind === "tool_call_update") {
    const bits = [update.status, update.title].filter(Boolean).join(" ");
    log(`[update] tool_call_update ${update.toolCallId} ${bits}`);
  } else if (kind === "plan" || kind === "plan_update") {
    log(`[update] ${kind}: ${(update.entries ?? []).map((e) => `${e.status}:${e.content}`).join(" | ")}`);
  } else if (kind === "available_commands_update") {
    log(`[update] 斜杠命令: ${(update.availableCommands ?? []).map((c) => "/" + c.name).join(" ")}`);
  } else {
    log(`[update] ${kind}`);
  }
});

// ---------- 主流程 ----------
const mcpServers = NO_MCP ? [] : [{
  name: "demo-tools",
  command: process.execPath,                        // 必须是绝对路径
  args: [path.join(import.meta.dirname, "mcp-server.mjs")],
  env: [],
}];

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  log("\n============================================");
  log("这一轮里 agent 反向调用了 client 的能力：");
  if (!Object.keys(reverseCalls).length) log("  （无）");
  for (const [m, n] of Object.entries(reverseCalls)) log(`  ${m}  ×${n}`);
  log("============================================");
  traceStream?.end();
  setTimeout(() => process.exit(code), 50);
}

setTimeout(() => { log("[client] 超时，终止 agent"); child.kill("SIGKILL"); finish(2); }, TIMEOUT_MS);

process.on("SIGINT", async () => {
  log("\n[client] 用户中断 → session/cancel");
  rpc.notify("session/cancel", { sessionId: SID });
});

let SID = "";
try {
  // ① 握手：先声明我有哪些能力
  const init = await rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      elicitation: { form: {} },
    },
    clientInfo: { name: "acp-client-demo", version: "1.0.0" },
  });
  log(`[client] 握手完成: agent=${init.agentInfo?.name} v${init.agentInfo?.version} proto=${init.protocolVersion}`);
  log(`[client] agent 能力: ${JSON.stringify(init.agentCapabilities ?? {})}`);

  // ② 建会话：顺手把"我这边的 MCP 工具"交给 agent
  const sess = await rpc.request("session/new", { cwd: CWD, mcpServers });
  SID = sess.sessionId;
  log(`[client] 会话: ${SID}  modes=${JSON.stringify(sess.modes?.availableModes?.map((m) => m.id) ?? [])}  当前=${sess.modes?.currentModeId ?? "?"}`);

  // ②.5 切模式：模式不同，"要不要问宿主"就不同
  //     auto/bypassPermissions 会绕过审批 → 你的 request_permission 永远收不到
  if (MODE) {
    await rpc.request("session/set_mode", { sessionId: SID, modeId: MODE });
    log(`[client] 已切到模式: ${MODE}`);
  }

  // ③ 发一轮，等它结束（prompt 是长请求）
  log(`\n[client] 发送: ${PROMPT}\n--------------------------------------------`);
  const res = await rpc.request("session/prompt", {
    sessionId: SID,
    prompt: [{ type: "text", text: PROMPT }],
  });
  log(`\n--------------------------------------------`);
  log(`[client] 本轮结束 stopReason=${res.stopReason}`);
  finish(0);
} catch (err) {
  log(`[client] 失败: ${err.message}`);
  finish(1);
}
