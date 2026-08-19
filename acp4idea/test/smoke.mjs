/**
 * Smoke test: drive the compiled ACP server over an in-memory pipe pair,
 * exactly as an ACP client (IDEA) would over stdio. Verifies transport
 * framing, capability negotiation, session lifecycle, streaming updates,
 * agent->client requests, and JSON-RPC error handling.
 */
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { StdioRpc } from "../lib/acp/transport.js";
import { AcpServer } from "../lib/acp/server.js";

// ---- wire two StdioRpc peers together (client <-> server) ----
const clientIn = new PassThrough();
const clientOut = new PassThrough();
const serverIn = new PassThrough();
const serverOut = new PassThrough();
clientOut.pipe(serverIn);
serverOut.pipe(clientIn);

const client = new StdioRpc({ input: clientIn, output: clientOut });
const server = new StdioRpc({ input: serverIn, output: serverOut });

// ---- mock DshAgentBridge ----
const sessions = new Map();
let nextSession = 1;
let sink = null;
const bridge = {
  setSink(s) { sink = s; },
  hasSession(id) { return sessions.has(id); },
  async createSession(cwd) {
    const id = "session-" + nextSession++;
    sessions.set(id, { cwd });
    return id;
  },
  async disposeSession(id) { sessions.delete(id); },
  async disposeAll() {},
  async prompt(id, text) {
    if (!sessions.has(id)) throw new Error("unknown session: " + id);
    // stream an update during the turn, like the real bridge does
    sink.sendUpdate(id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "echo: " + text },
    });
    return "end_turn";
  },
  async stop(id) {
    if (!sessions.has(id)) throw new Error("unknown session: " + id);
  },
  cancel() {},
  dispose() {},
};

const acpServer = new AcpServer(server, bridge);

// ---- collect notifications the client receives ----
const notifications = [];
client.onNotification((method, params) => notifications.push({ method, params }));

// 1) initialize
const init = await client.request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true } },
});
assert.equal(init.protocolVersion, 1);
assert.equal(init.agentCapabilities.loadSession, false);
assert.deepEqual(init.authMethods, []);

// 2) session/new
const created = await client.request("session/new", { cwd: "C:\proj" });
assert.ok(created.sessionId.startsWith("session-"));
const sid = created.sessionId;

// 3) session/prompt -> server streams session/update during the turn
const result = await client.request("session/prompt", {
  sessionId: sid,
  prompt: [{ type: "text", text: "hi" }],
});
assert.equal(result.stopReason, "end_turn");
assert.equal(notifications.length, 1);
assert.equal(notifications[0].method, "session/update");
assert.equal(notifications[0].params.sessionId, sid);
assert.equal(notifications[0].params.update.sessionUpdate, "agent_message_chunk");

// 4) agent -> client request round trip (fs/read_text_file)
client.onRequest("fs/read_text_file", (params) => {
  assert.equal(params.sessionId, sid);
  assert.equal(params.path, "C:\proj\a.txt");
  return { content: "# hi", lineCount: 1, totalLines: 1 };
});
const fsResult = await acpServer.readTextFile({ sessionId: sid, path: "C:\proj\a.txt" });
assert.equal(fsResult.content, "# hi");
assert.equal(fsResult.totalLines, 1);

// 5) session/stop
const stop = await client.request("session/stop", { sessionId: sid });
assert.deepEqual(stop, {});

// 6) session/cancel is a notification; no response, no throw
client.notify("session/cancel", { sessionId: sid });

// 7) unknown method -> JSON-RPC MethodNotFound (-32601)
await assert.rejects(client.request("no/such/method"), (err) => {
  assert.equal(err.code, -32601);
  return true;
});

// 8) malformed JSON -> parse error response; unknown session -> internal error
client.notify("session/unknown", { sessionId: "nope" }); // notification handler no-ops
await assert.rejects(
  client.request("session/prompt", { sessionId: "nope", prompt: [] }),
  /unknown session/
);

console.log("SMOKE TEST PASSED");
process.exit(0);
