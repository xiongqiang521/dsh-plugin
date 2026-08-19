/**
 * Unit tests for SessionUpdatePump: coalescing by kind, byte-cap flush,
 * structural ordering barriers, flush-before-completion, legacy mode, and
 * dispose semantics.
 */
import assert from "node:assert/strict";
import { SessionUpdatePump, parseSessionUpdateMode } from "../lib/acp/session-update-pump.js";

/** Collect delivered updates with a tiny delay so timers can fire. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function makePump(options = {}) {
  const delivered = [];
  const pump = new SessionUpdatePump(
    { sendUpdate: (_sessionId, update) => delivered.push(update) },
    "s1",
    { flushDelayMs: 20, ...options },
  );
  return { pump, delivered };
}

// ---- coalescing: consecutive same-kind deltas merge into one notification ----
{
  const { pump, delivered } = makePump();
  pump.appendAgentMessage("Hel");
  pump.appendAgentMessage("lo ");
  pump.appendAgentMessage("world");
  await pump.flush();
  assert.equal(delivered.length, 1, "three appends coalesce into one update");
  assert.deepEqual(delivered[0], {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Hello world" },
  });
}

// ---- kind barrier: text and thought deltas never merge ----
{
  const { pump, delivered } = makePump();
  pump.appendAgentMessage("answer");
  pump.appendAgentThought("hmm");
  pump.appendAgentMessage("!");
  await pump.flush();
  assert.deepEqual(delivered.map((u) => [u.sessionUpdate, u.content.text]), [
    ["agent_message_chunk", "answer"],
    ["agent_thought_chunk", "hmm"],
    ["agent_message_chunk", "!"],
  ]);
}

// ---- byte cap: runs are split so no single notification exceeds the cap ----
{
  const { pump, delivered } = makePump({ maxBufferedBytes: 8 });
  pump.appendAgentMessage("12345");
  pump.appendAgentMessage("6789"); // 5 + 4 bytes > 8 -> split into two updates
  await pump.flush();
  assert.deepEqual(delivered.map((u) => u.content.text), ["12345", "6789"]);
}
{
  // a single chunk already over the cap flushes on its own append
  const { pump, delivered } = makePump({ maxBufferedBytes: 4 });
  pump.appendAgentMessage("12345");
  await pump.flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].content.text, "12345");
}

// ---- structural barrier: send() flushes buffered text first, FIFO ----
{
  const { pump, delivered } = makePump();
  pump.appendAgentMessage("prefix");
  pump.send({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "in_progress" });
  pump.appendAgentMessage("suffix");
  await pump.flush();
  assert.deepEqual(delivered.map((u) => u.sessionUpdate), [
    "agent_message_chunk",
    "tool_call",
    "agent_message_chunk",
  ]);
  assert.equal(delivered[0].content.text, "prefix");
  assert.equal(delivered[2].content.text, "suffix");
}

// ---- legacy mode: every delta is its own notification ----
{
  const { pump, delivered } = makePump({ mode: "legacy" });
  pump.appendAgentMessage("a");
  pump.appendAgentMessage("b");
  await pump.flush();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].content.text, "a");
  assert.equal(delivered[1].content.text, "b");
}

// ---- flush() waits for queued structural updates ----
{
  const { pump, delivered } = makePump();
  pump.send({ sessionUpdate: "plan", entries: [] });
  pump.send({ sessionUpdate: "usage_update", used: 10, size: 100 });
  await pump.flush();
  assert.equal(delivered.length, 2);
}

// ---- timer-driven flush when nothing calls flush() ----
{
  const { pump, delivered } = makePump({ flushDelayMs: 10 });
  pump.appendAgentMessage("async");
  await tick();
  await tick();
  assert.equal(delivered.length, 1, "flush timer fires without an explicit flush");
}

// ---- dispose() abandons buffered work ----
{
  const { pump, delivered } = makePump();
  pump.appendAgentMessage("never");
  pump.dispose();
  await pump.flush();
  assert.equal(delivered.length, 0);
}

// ---- parseSessionUpdateMode ----
{
  assert.equal(parseSessionUpdateMode(undefined), "coalesced");
  assert.equal(parseSessionUpdateMode("coalesced"), "coalesced");
  assert.equal(parseSessionUpdateMode("legacy"), "legacy");
  assert.throws(() => parseSessionUpdateMode("bogus"), /coalesced|legacy/);
}

console.log("PUMP TESTS PASSED");
process.exit(0);
