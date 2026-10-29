// 最小 NDJSON JSON-RPC 2.0 双工通道（无任何依赖）
// ACP 的线上格式就是：一行一条 JSON，stdin/stdout 各一方向。
import readline from "node:readline";

export function createRpc({ input, output, onTrace }) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let nextId = 1;
  const pending = new Map();          // 我方发出的请求 → 等对方回包
  const requestHandlers = new Map();  // 对方发来的请求 → 我方处理
  const notificationHandlers = new Map();

  const write = (msg) => {
    onTrace?.({ dir: "out", msg });
    output.write(JSON.stringify(msg) + "\n");
  };

  const request = (method, params) => {
    const id = nextId++;
    write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
  };

  const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const replyError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { console.error("[rpc] 收到非 JSON 行，丢弃:", line.slice(0, 120)); return; }

    onTrace?.({ dir: "in", msg });
    const hasId = msg.id !== undefined && msg.id !== null;

    // 1) 对方发来的请求（会阻塞对方，必须回包）
    if (msg.method && hasId) {
      const handler = requestHandlers.get(msg.method);
      if (!handler) {
        // 不认识就明确拒绝，让对方自己降级 —— 这是唯一正确的兜底
        replyError(msg.id, -32601, `Method not found: ${msg.method}`);
        return;
      }
      try { reply(msg.id, (await handler(msg.params)) ?? null); }
      catch (err) { replyError(msg.id, -32000, String(err?.message ?? err)); }
      return;
    }

    // 2) 对方发来的通知（无 id，不需要回）
    if (msg.method) {
      const handler = notificationHandlers.get(msg.method);
      if (handler) { try { await handler(msg.params); } catch (e) { console.error("[rpc] handler 抛错:", e?.message); } }
      else if (!msg.method.startsWith("session/update")) console.error("[rpc] 未处理的通知:", msg.method);
      return;
    }

    // 3) 我方请求的响应
    if (hasId) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, method: p.method }));
      else p.resolve(msg.result);
    }
  });

  return {
    request,
    notify,
    onRequest(method, handler) { requestHandlers.set(method, handler); return this; },
    onNotification(method, handler) { notificationHandlers.set(method, handler); return this; },
    onClose(fn) { rl.once("close", fn); },
    get pendingCount() { return pending.size; },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
