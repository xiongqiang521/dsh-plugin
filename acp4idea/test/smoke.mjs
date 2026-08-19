/**
 * Smoke test: drive the compiled ACP server over an in-memory pipe pair,
 * exactly as an ACP client (IDEA) would over stdio. Verifies transport
 * framing, capability negotiation (agentInfo, protocol negotiation), session
 * lifecycle, pump-driven streaming (coalesced), queued prompts + cancel,
 * execution-mode switching (session/set_mode), model selection
 * (session/set_config_option + legacy session/set_model), usage_update /
 * session_info_update, agent->client requests, and JSON-RPC error handling.
 */
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { StdioRpc, RpcRequestError } from "../lib/acp/transport.js";
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

// ---- mock DshAgentBridge: modes (presets), model selection, queue, cancel ----
const MODES = [
  { id: "code", name: "Code", description: "Default coding mode" },
  { id: "plan", name: "Plan", description: "Plan-first mode" },
];
const MODELS = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"];
const EFFORTS = ["low", "medium", "high"];

const sessions = new Map(); // id -> { cwd, pump, running, queue, modeId, model, effort }
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
        modeId: "code",
        model: "deepseek/deepseek-chat",
        effort: "medium",
      });
      return id;
    },
    async disposeSession(id) { sessions.delete(id); },
    async disposeAll() {},
    async getSessionConfig(id) {
      requireSession(id);
      return { modes: { currentModeId: modeOf(id), availableModes: MODES }, configOptions: configOptionsOf(id) };
    },
    async setMode(id, modeId) {
      requireSession(id);
      const s = sessions.get(id);
      if (!MODES.some((m) => m.id === modeId)) throw rpcError(-32602, "unknown modeId: " + modeId);
      if (s.produced) throw rpcError(-32602, "cannot switch mode: the session already produced content");
      s.modeId = modeId;
      s.pump.send({ sessionUpdate: "current_mode_update", currentModeId: modeId });
      s.pump.send({ sessionUpdate: "config_option_update", configOptions: configOptionsOf(id) });
    },
    async setConfigOption(id, configId, value) {
      const s = requireSession(id);
      if (configId === "model") {
        if (typeof value !== "string") throw rpcError(-32602, "model value must be a string");
        if (!MODELS.includes(value)) throw rpcError(-32602, "unknown model: " + value);
        s.model = value;
      } else if (configId === "thought_level") {
        if (typeof value !== "string") throw rpcError(-32602, "thought_level value must be a string");
        if (!EFFORTS.includes(value)) throw rpcError(-32602, "unknown thought level: " + value);
        s.effort = value;
      } else {
        throw rpcError(-32602, "unknown config option: " + configId);
      }
      const configOptions = configOptionsOf(id);
      s.pump.send({ sessionUpdate: "config_option_update", configOptions });
      return configOptions;
    },
    async setModel(id, modelId) {
      const s = requireSession(id);
      if (!MODELS.includes(modelId)) throw rpcError(-32602, "unknown model: " + modelId);
      s.model = modelId;
      s.pump.send({ sessionUpdate: "config_option_update", configOptions: configOptionsOf(id) });
    },
    async prompt(id, text) {
      const s = requireSession(id);
      if (s.running) {
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
      const s = requireSession(id);
      cancelSession(s);
    },
    cancel(id) { cancelSession(sessions.get(id)); },
    dispose() {},
  };

  function requireSession(id) {
    const s = sessions.get(id);
    if (!s) throw new Error("unknown session: " + id);
    return s;
  }
  function modeOf(id) { return sessions.get(id).modeId; }
  function configOptionsOf(id) {
    const s = sessions.get(id);
    return [
      {
        type: "select",
        id: "model",
        category: "model",
        name: "Model",
        description: "Select the model for this session",
        currentValue: s.model,
        options: MODELS.map((value) => ({ value, name: value, description: null })),
      },
      {
        type: "select",
        id: "thought_level",
        category: "thought_level",
        name: "Thinking",
        description: "Set the reasoning effort for this session",
        currentValue: s.effort,
        options: EFFORTS.map((value) => ({ value, name: value, description: null })),
      },
    ];
  }
  function rpcError(code, message) {
    return new RpcRequestError(code, message);
  }
  function cancelSession(s) {
    if (!s) return;
    for (const q of s.queue.splice(0, s.queue.length)) q.resolve("cancelled");
    if (s.running) s.cancelled = true;
  }
  async function runTurn(s, text) {
    s.running = true;
    s.produced = true;
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
const updatesOf = (kind) =>
  notifications.filter((n) => n.params?.update?.sessionUpdate === kind).map((n) => n.params.update);

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

// 3) session/new advertises modes + config options
const created = await client.request("session/new", { cwd: "C:\\proj" });
assert.ok(created.sessionId.startsWith("session-"));
const sid = created.sessionId;
assert.equal(created.modes.currentModeId, "code");
assert.deepEqual(created.modes.availableModes.map((m) => m.id), ["code", "plan"]);
assert.deepEqual(created.configOptions.map((o) => o.id), ["model", "thought_level"]);
assert.equal(created.configOptions[0].currentValue, "deepseek/deepseek-chat");

// 4) session/set_mode switches mode and notifies
const modeResult = await client.request("session/set_mode", { sessionId: sid, modeId: "plan" });
assert.deepEqual(modeResult, {});
assert.deepEqual(updatesOf("current_mode_update").at(-1), {
  sessionUpdate: "current_mode_update",
  currentModeId: "plan",
});

// 5) unknown mode -> InvalidParams (-32602)
await assert.rejects(client.request("session/set_mode", { sessionId: sid, modeId: "bogus" }), (err) => {
  assert.equal(err.code, -32602);
  return true;
});

// 6) session/set_config_option("model") returns the refreshed list + notifies
const modelOpt = await client.request("session/set_config_option", {
  sessionId: sid,
  configId: "model",
  value: "deepseek/deepseek-reasoner",
});
assert.equal(modelOpt.configOptions[0].currentValue, "deepseek/deepseek-reasoner");
assert.deepEqual(updatesOf("config_option_update").at(-1).configOptions[0].currentValue, "deepseek/deepseek-reasoner");

// 7) session/set_config_option("thought_level")
const thoughtOpt = await client.request("session/set_config_option", {
  sessionId: sid,
  configId: "thought_level",
  value: "high",
});
assert.equal(thoughtOpt.configOptions[1].currentValue, "high");

// 8) unknown config option -> InvalidParams
await assert.rejects(
  client.request("session/set_config_option", { sessionId: sid, configId: "bogus", value: "x" }),
  (err) => err.code === -32602,
);

// 9) legacy session/set_model surface still switches the model
await client.request("session/set_model", { sessionId: sid, modelId: "deepseek/deepseek-chat" });
assert.equal(updatesOf("config_option_update").at(-1).configOptions[0].currentValue, "deepseek/deepseek-chat");

// 10) session/prompt -> pump coalesces the two deltas into ONE session/update,
//     then usage + session_info arrive after the turn
const result = await client.request("session/prompt", {
  sessionId: sid,
  prompt: [{ type: "text", text: "hi" }],
});
assert.equal(result.stopReason, "end_turn");
const messageChunks = updatesOf("agent_message_chunk").filter((u) => u.content.text.startsWith("echo:"));
assert.equal(messageChunks.length, 1, "coalesced deltas arrive as one chunk");
assert.equal(messageChunks[0].content.text, "echo: hi");
assert.deepEqual(updatesOf("usage_update").at(-1), { sessionUpdate: "usage_update", used: 42, size: 131072 });
assert.ok(updatesOf("session_info_update").at(-1).updatedAt);

// 11) a prompt while a turn is running queues; both resolve; queue notice sent
notifications.length = 0;
const p1 = client.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "one" }] });
await new Promise((r) => setTimeout(r, 5)); // let the first turn start
const p2 = client.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "two" }] });
const [r1, r2] = await Promise.all([p1, p2]);
assert.equal(r1.stopReason, "end_turn");
assert.equal(r2.stopReason, "end_turn");
assert.ok(
  notifications.some(
    (n) => n.params?.update?.sessionUpdate === "agent_message_chunk" &&
      /Queued message \(position 1\)/.test(n.params.update.content.text),
  ),
  "queue-position notice reached the client",
);

// 12) a session that produced content refuses mode switches
await assert.rejects(client.request("session/set_mode", { sessionId: sid, modeId: "code" }), (err) => {
  assert.equal(err.code, -32602);
  assert.match(err.message, /already produced/);
  return true;
});

// 13) agent -> client request round trip (fs/read_text_file)
client.onRequest("fs/read_text_file", (params) => {
  assert.equal(params.sessionId, sid);
  assert.equal(params.path, "C:\\proj\\a.txt");
  return { content: "# hi", lineCount: 1, totalLines: 1 };
});
const fsResult = await acpServer.readTextFile({ sessionId: sid, path: "C:\\proj\\a.txt" });
assert.equal(fsResult.content, "# hi");
assert.equal(fsResult.totalLines, 1);

// 14) session/stop + session/cancel (notification, no response)
const stop = await client.request("session/stop", { sessionId: sid });
assert.deepEqual(stop, {});
client.notify("session/cancel", { sessionId: sid });

// 15) unknown method -> JSON-RPC MethodNotFound (-32601)
await assert.rejects(client.request("no/such/method"), (err) => {
  assert.equal(err.code, -32601);
  return true;
});

// 16) unknown session -> internal error
await assert.rejects(
  client.request("session/prompt", { sessionId: "nope", prompt: [] }),
  /unknown session/,
);

console.log("SMOKE TEST PASSED");
process.exit(0);
