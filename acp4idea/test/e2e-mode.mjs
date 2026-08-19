/**
 * End-to-end test against a real host dsh (--profile acp), verifying the
 * mode (agent presets) and model selection adaptation over real stdio.
 *
 * Optional test: requires the host `dsh` install and a configured `acp`
 * profile with a model + preset roster. NOT part of `pnpm test`.
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const DSH_BIN = process.env.DSH_BIN_JS ||
  "C:\\Users\\XQ\\AppData\\Local\\nvm\\v24.19.0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";

const child = spawn(process.execPath, [DSH_BIN, "--profile", "acp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

const pending = new Map();
const notifications = [];
let buffer = "";
let nextId = 1;
let stderr = "";

child.stderr.on("data", (d) => { stderr += d.toString(); });

child.stdout.on("data", (d) => {
  buffer += d.toString();
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) { nl = buffer.indexOf("\n"); continue; }
    const msg = JSON.parse(line);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    } else if (msg.method === "session/update") {
      notifications.push(msg.params);
    }
    nl = buffer.indexOf("\n");
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(method, params) {
  const id = "t" + nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const updates = (kind) => notifications.filter((n) => n.update?.sessionUpdate === kind).map((n) => n.update);

try {
  // 1) initialize
  const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentInfo.name, "@deepseek-ai/dsh-acp4idea");
  console.log("[1] initialize OK, agentInfo:", init.agentInfo.name, init.agentInfo.version);

  // 2) session/new -> modes + configOptions
  const created = await request("session/new", { cwd: process.cwd() });
  assert.ok(created.sessionId);
  const sid = created.sessionId;
  console.log("[2] session/new modes:", JSON.stringify(created.modes));
  console.log("[2] configOptions:", JSON.stringify(created.configOptions?.map((o) => ({ id: o.id, currentValue: o.currentValue, values: o.options?.length }))));
  assert.ok(Array.isArray(created.modes?.availableModes), "modes advertised");
  assert.ok(Array.isArray(created.configOptions) && created.configOptions.length > 0, "configOptions advertised");

  // 3) set_mode -> current_mode_update
  const modeId = created.modes.availableModes.find((m) => m.id !== created.modes.currentModeId)?.id;
  if (modeId) {
    await request("session/set_mode", { sessionId: sid, modeId });
    await sleep(150);
    const last = updates("current_mode_update").at(-1);
    assert.equal(last?.currentModeId, modeId);
    console.log("[3] set_mode OK:", created.modes.currentModeId, "->", modeId);
  } else {
    console.log("[3] set_mode skipped (single mode)");
  }

  // 4) set_config_option(model) -> refreshed options
  const modelOption = created.configOptions.find((o) => o.id === "model");
  if (modelOption) {
    const current = modelOption.currentValue;
    const alt = modelOption.options.find((o) => o.value !== current);
    if (alt) {
      const res = await request("session/set_config_option", { sessionId: sid, configId: "model", value: alt.value });
      assert.equal(res.configOptions.find((o) => o.id === "model").currentValue, alt.value);
      await sleep(100);
      console.log("[4] set_config_option(model) OK:", current, "->", alt.value);
    } else {
      console.log("[4] set_config_option(model) skipped (single model)");
    }
  } else {
    console.log("[4] set_config_option(model) skipped (no model option)");
  }

  // 5) legacy session/set_model
  const modelOption2 = created.configOptions.find((o) => o.id === "model");
  if (modelOption2 && modelOption2.options.length > 1) {
    await request("session/set_model", { sessionId: sid, modelId: modelOption2.options[0].value });
    await sleep(100);
    console.log("[5] set_model OK");
  } else {
    console.log("[5] set_model skipped");
  }

  // 6) one short prompt -> streaming + usage_update (consumes a little quota)
  const promptResult = await request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "Reply with OK only." }] });
  await sleep(300);
  assert.equal(promptResult.stopReason, "end_turn");
  const textChunks = updates("agent_message_chunk").filter((u) => u.content?.text?.trim());
  console.log("[6] prompt OK stopReason:", promptResult.stopReason, "| text chunks:", textChunks.length, "| usage:", JSON.stringify(updates("usage_update").at(-1)));
  assert.ok(textChunks.length > 0, "streamed text reached the client");

  // 7) mode switch after content -> refused (InvalidParams)
  const modeId2 = updates("current_mode_update").at(-1)?.currentModeId ?? created.modes.currentModeId;
  const other = created.modes.availableModes.find((m) => m.id !== modeId2)?.id;
  if (other) {
    try {
      await request("session/set_mode", { sessionId: sid, modeId: other });
      console.log("[7] WARN: mode switch after content was NOT refused");
    } catch (e) {
      console.log("[7] mode switch after content refused:", e.message);
    }
  }

  console.log("E2E MODE TEST PASSED");
  process.exit(0);
} catch (err) {
  console.error("E2E MODE TEST FAILED:", err.message);
  console.error("[dsh stderr tail]", stderr.slice(-2000));
  process.exit(1);
} finally {
  try { child.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 500);
}
