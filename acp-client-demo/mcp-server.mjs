#!/usr/bin/env node
// 最小 MCP server（stdio，零依赖）：让 agent 能"反向调用宿主提供的工具"。
//
// 注意区分两条路：
//   1. ACP 的 fs/* terminal/* —— 宿主提供【能力】
//   2. session/new 里的 mcpServers —— 宿主提供【工具】（本文件）
// 两者都能让 agent"回调"到客户端一侧，但走的是不同协议：后者是 MCP。
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const SKILL_DIR = path.join(import.meta.dirname, "skills");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

const TOOLS = [
  {
    name: "read_skill",
    description: "读取本机 skills 目录里的技能文档（这就是 ACP 里没有的 skill 能力的实际落地方式）",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "技能名，例如 greeting" } },
      required: ["name"],
    },
  },
  {
    name: "list_skills",
    description: "列出本机所有可用的技能",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "host_info",
    description: "返回宿主机信息（演示宿主侧工具能拿到 agent 拿不到的东西）",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name, args = {}) {
  if (name === "read_skill") {
    const file = path.join(SKILL_DIR, `${args.name}.md`);
    const content = await readFile(file, "utf8");
    return { content: [{ type: "text", text: content }] };
  }
  if (name === "list_skills") {
    const files = await readdir(SKILL_DIR);
    return { content: [{ type: "text", text: files.map((f) => f.replace(/\.md$/, "")).join(", ") }] };
  }
  if (name === "host_info") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, cwd: process.cwd() }, null, 2),
      }],
    };
  }
  throw new Error(`unknown tool: ${name}`);
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const sendErr = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

  try {
    switch (method) {
      case "initialize":
        return send({
          // 回声协商：客户端要多新就给多新，避免版本不匹配
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "demo-tools", version: "1.0.0" },
        });
      case "notifications/initialized":
        return; // 通知，无需响应
      case "tools/list":
        return send({ tools: TOOLS });
      case "tools/call":
        return send(await callTool(params?.name, params?.arguments));
      case "ping":
        return send({});
      default:
        return sendErr(-32601, `method not found: ${method}`);
    }
  } catch (err) {
    sendErr(-32000, String(err?.message ?? err));
  }
});
