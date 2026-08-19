/**
 * Smoke test: drive the compiled ACP server over an in-memory pipe pair,
 * exactly as an ACP client (IDEA) would over stdio. Verifies transport
 * framing, capability negotiation (agentInfo, protocol negotiation), session
 * lifecycle, pump-driven streaming (coalesced), queued prompts + cancel,
 * usage_update / session_info_update, agent->client requests, and JSON-RPC
 * error handling.
 */
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { StdioRpc } from "../lib/acp/transport.js";
import { AcpServer } from "../lib/acp/server.js";
import { SessionUpdatePump } from "../lib/acp/session-update-pump.js";

// ---- wire two StdioRpc peers together (client <-> server) ----
const clientIn = new PassThrough();
const clientOut = new PassThrough();
const serverIn = new PassThrough();
const serverOut = new PassThrough();
clientOut.pipe(serverIn);
serverOut.pipe(clientIn);

const client = new StdioRpc({ input: clientIn, output: clientOut });
const server = new StdioRpc({ input: serverIn, output: serverOut });

// ---- mock DshAgentBridge: one pump per session, queue + cancel semantics ----
const sessions = new Map(); // id -> { cwd, pump, running, queue }
let nextSession = 1;
let sink = null;

function makeBridge() {
  return {
    setSink(s) { sink = s; },
    hasSession(id) { return sessions.has(id); },
    async createSession(cwd) {
      const id = "session-" + nextSession++;
      sessions.set(id, {
        cwd,
        pump: new SessionUpdatePump(sink, id, { flushDelayMs: 10 }),
        running: false,
        queue: [],
      });
      return id;
    },
    async disposeSession(id) { sessions.delete(id); },
    async disposeAll() {},
    async prompt(id, text) {
      const s = sessions.get(id);
      if (!s) throw new Error("unknown session: " + id);
      if (s.running) {
        // queue like the real bridge and tell the client its position
        return new Promise((resolve) => {
          s.queue.push({ text, resolve });
          s.pump.send({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Queued message (position ${s.queue.length}).` },
          });
        });
      }
      return runTurn(s, text);
    },
    async stop(id) {
      const s = sessions.get(id);
      if (!s) throw new Error("unknown session: " + id);
      cancelSession(s);
    },
    cancel(id) { cancelSession(sessions.get(id)); },
    dispose() {},
  };

  function cancelSession(s) {
    if (!s) return;
    for (const q of s.queue.splice(0, s.queue.length)) q.resolve("cancelled");
    if (s.running) s.cancelled = true;
  }

  async function runTurn(s, text) {
    s.running = true;
    try {
      // keep the turn visibly running so a second prompt demonstrably queues
      await new Promise((r) => setTimeout(r, 30));
      // stream deltas through the pump (coalesced into one notification)
      for (const part of ["echo: ", text]) s.pump.appendAgentMessage(part);
      // usage + activity, like the real bridge's post-turn emission
      s.pump.send({ sessionUpdate: "usage_update", used: 42, size: 131072 });
      s.pump.send({ sessionUpdate: "session_info_update", updatedAt: "2026-01-01T00:00:00.000Z" });
      await s.pump.flush();
      return s.cancelled ? "cancelled" : "end_turn";
    } finally {
      s.running = false;
      s.cancelled = false;
      const next = s.queue.shift();
      if (next) void runTurn(s, next.text).then(next.resolve, () => next.resolve("end_turn"));
    }
  }
}

const acpServer = new AcpServer(server, makeBridge());

// ---- collect notifications the client receives ----
const notifications = [];
client.onNotification((method, params) => notifications.push({ method, params }));

// 1) initialize: agentInfo present, protocol negotiation, capabilities
const init = await client.request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true } },
});
assert.equal(init.protocolVersion, 1);
assert.equal(init.agentCapabilities.loadSession, false);
assert.deepEqual(init.authMethods, []);
assert.equal(init.agentInfo.name, "@deepseek-ai/dsh-acp4idea");
assert.ok(typeof init.agentInfo.version === "string" && init.agentInfo.version.length > 0);

// 2) session/new requires an absolute cwd
await assert.rejects(client.request("session/new", { cwd: "relative" }), /absolute path/);

// 3) session/new with absolute cwd
const created = await client.request("session/new", { cwd: "C:\\proj" });
assert.ok(created.sessionId.startsWith("session-"));
const sid = created.sessionId;

// 4) session/prompt -> pump coalesces the two deltas into ONE session/update,
//    then usage + session_info arrive after the turn
const result = await client.request("session/prompt", {
  sessionId: sid,
  prompt: [{ type: "text", text: "hi" }],
});
assert.equal(result.stopReason, "end_turn");
const updates = notifications.filter((n) => n.method === "session/update").map((n) => n.params.update);
const messageChunk = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
assert.equal(messageChunk.length, 1, "coalesced deltas arrive as one chunk");
assert.equal(messageChunk[0].content.text, "echo: hi");
const usage = updates.find((u) => u.sessionUpdate === "usage_update");
assert.deepEqual(usage, { sessionUpdate: "usage_update", used: 42, size: 131072 });
const info = updates.find((u) => u.sessionUpdate === "session_info_update");
assert.equal(info.sessionUpdate, "session_info_update");
assert.ok(info.updatedAt);

// 5) a prompt while a turn is running queues; the second prompt resolves after
//    the first, and the queue-position notice arrives in order
notifications.length = 0;
const p1 = client.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "one" }] });
await new Promise((r) => setTimeout(r, 5)); // let the first turn start
const p2 = client.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "two" }] });
const [r1, r2] = await Promise.all([p1, p2]);
assert.equal(r1.stopReason, "end_turn");
assert.equal(r2.stopReason, "end_turn");
const queuedNotice = notifications.some(
  (n) => n.params.update?.sessionUpdate === "agent_message_chunk" &&
    /Queued message \(position 1\)/.test(n.params.update.content.text),
);
assert.ok(queuedNotice, "queue-position notice reached the client");

// 6) agent -> client request round trip (fs/read_text_file)
client.onRequest("fs/read_text_file", (params) => {
  assert.equal(params.sessionId, sid);
  assert.equal(params.path, "C:\\proj\\a.txt");
  return { content: "# hi", lineCount: 1, totalLines: 1 };
});
const fsResult = await acpServer.readTextFile({ sessionId: sid, path: "C:\\proj\\a.txt" });
assert.equal(fsResult.content, "# hi");
assert.equal(fsResult.totalLines, 1);

// 7) session/stop
const stop = await client.request("session/stop", { sessionId: sid });
assert.deepEqual(stop, {});

// 8) session/cancel is a notification; no response, no throw
client.notify("session/cancel", { sessionId: sid });

// 9) unknown method -> JSON-RPC MethodNotFound (-32601)
await assert.rejects(client.request("no/such/method"), (err) => {
  assert.equal(err.code, -32601);
  return true;
});

// 10) unknown session -> internal error
await assert.rejects(
  client.request("session/prompt", { sessionId: "nope", prompt: [] }),
  /unknown session/,
);

console.log("SMOKE TEST PASSED");
process.exit(0);
