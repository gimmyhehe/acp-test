#!/usr/bin/env node
// 教学用 ACP agent：故意把 client 的每一种反向能力都调一遍。
// 用途：在没有真 agent、没有账号、不花钱的前提下，验证 client 的反向调用实现是否正确。
//
// 它做的事：收到 prompt 后 → 读文件 → 跑终端 → 请求审批 → 报计划 → 流式回答 → 返回 stopReason
import { createRpc } from "./stdio-rpc.mjs";

const rpc = createRpc({ input: process.stdin, output: process.stdout });
const sessions = new Map();

rpc.onRequest("initialize", () => ({
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
  },
  authMethods: [],
  agentInfo: { name: "mock-agent", version: "0.1.0" },
}));

rpc.onRequest("session/new", ({ cwd }) => {
  const sessionId = `mock_${Date.now().toString(36)}`;
  sessions.set(sessionId, { cwd, cancelled: false });
  return {
    sessionId,
    modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] },
    configOptions: [],
  };
});

rpc.onNotification("session/cancel", ({ sessionId }) => {
  const s = sessions.get(sessionId);
  if (s) s.cancelled = true;
});

const update = (sessionId, payload) => rpc.notify("session/update", { sessionId, update: payload });
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

rpc.onRequest("session/prompt", async ({ sessionId, prompt }) => {
  const s = sessions.get(sessionId);
  const text = (prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
  say(sessionId, `收到你的话：「${text}」\n\n我现在依次反向调用宿主的能力：\n`);

  if (s?.cancelled) return { stopReason: "cancelled" };

  // ① 读文件：走宿主的 fs/read_text_file（而不是自己读盘）
  try {
    const target = `${s.cwd}/client.mjs`;
    const { content } = await rpc.request("fs/read_text_file", { sessionId, path: target });
    say(sessionId, `\n① fs/read_text_file ✅ 读到了 ${content.length} 字符（${target}）\n`);
  } catch (e) {
    say(sessionId, `\n① fs/read_text_file ❌ ${e.message}\n`);
  }

  // ② 跑终端：走宿主的 terminal/*
  try {
    const { terminalId } = await rpc.request("terminal/create", {
      sessionId,
      command: "node",
      args: ["-e", "console.log('hello from', process.platform)"],
      env: [],
      outputByteLimit: 65536,
    });
    const { exitCode } = await rpc.request("terminal/wait_for_exit", { sessionId, terminalId });
    const out = await rpc.request("terminal/output", { sessionId, terminalId });
    await rpc.request("terminal/release", { sessionId, terminalId });
    say(sessionId, `② terminal/* ✅ 退出码 ${exitCode}，输出：${out.output.trim()}\n`);
  } catch (e) {
    say(sessionId, `② terminal/* ❌ ${e.message}\n`);
  }

  // ③ 审批：问宿主准不准
  try {
    const { outcome } = await rpc.request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "call_demo_1",
        title: "写入 demo.txt",
        kind: "edit",
        status: "pending",
        content: [{ type: "diff", path: "demo.txt", oldText: "", newText: "hello\n" }],
      },
      options: [
        { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
        { optionId: "allow_always", name: "总是允许", kind: "allow_always" },
        { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
      ],
    });
    const verdict =
      outcome.outcome === "selected"
        ? outcome.optionId.startsWith("allow") ? "批准" : "拒绝"
        : "取消";
    say(sessionId, `③ session/request_permission ✅ 宿主裁决：${verdict}（${outcome.optionId ?? outcome.outcome}）\n`);
  } catch (e) {
    say(sessionId, `③ session/request_permission ❌ ${e.message}\n`);
  }

  // ④ 计划：让宿主渲染 todo
  update(sessionId, {
    sessionUpdate: "plan",
    entries: [
      { content: "读文件验证 fs 通道", status: "completed", priority: "high" },
      { content: "跑终端验证 terminal 通道", status: "completed", priority: "medium" },
      { content: "确认审批链路", status: "in_progress", priority: "high" },
    ],
  });
  say(sessionId, `\n④ plan 上报 ✅（宿主应能渲染成 todo 列表）\n\n反向调用演示完毕。`);

  return { stopReason: s?.cancelled ? "cancelled" : "end_turn" };
});

process.stdin.on("end", () => process.exit(0));
