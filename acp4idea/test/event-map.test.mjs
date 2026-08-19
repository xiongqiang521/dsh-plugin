/**
 * Unit tests for the pure dsh-event -> ACP-op mapper: token-level streaming
 * ops from assistant/chunk, assembled-message fallback + usage from
 * assistant/message, canonical tool_call / tool_call_update shapes, and plan
 * snapshots.
 */
import assert from "node:assert/strict";
import { mapSessionEvent } from "../lib/bridge/event-map.js";

// ---- assistant/chunk: text deltas -> append-text; reasoning -> append-thought ----
{
  const ops = mapSessionEvent({
    type: "assistant/chunk",
    data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "Hi" } },
  });
  assert.deepEqual(ops, [{ op: "append-text", turn: 1, step: 1, text: "Hi" }]);
}
{
  const ops = mapSessionEvent({
    type: "assistant/chunk",
    data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "think" } },
  });
  assert.deepEqual(ops, [{ op: "append-thought", turn: 1, step: 1, text: "think" }]);
}
{
  // empty deltas and non-streamable chunks produce no ops
  const ops = mapSessionEvent({
    type: "assistant/chunk",
    data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "" } },
  });
  assert.deepEqual(ops, []);
}
{
  const ops = mapSessionEvent({
    type: "assistant/chunk",
    data: { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 1, id: "c1", argumentsDelta: "{}" } },
  });
  assert.deepEqual(ops, []);
}

// ---- assistant/message: assembled text + usage (bridge decides dedupe) ----
{
  const ops = mapSessionEvent({
    type: "assistant/message",
    data: {
      turn: 1,
      step: 2,
      message: {
        content: [
          { type: "reasoning", text: "r1" },
          { type: "text", text: "t1" },
          { type: "text", text: "t2" },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 },
    },
  });
  assert.deepEqual(ops, [{
    op: "assistant-message",
    turn: 1,
    step: 2,
    textParts: ["t1", "t2"],
    thinkingParts: ["r1"],
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 },
  }]);
}

// ---- tool/call: canonical kind/status, parsed rawInput, locations ----
{
  const ops = mapSessionEvent({
    type: "tool/call",
    data: { callId: "call-1", name: "bash", arguments: '{"command":"ls"}' },
  });
  assert.deepEqual(ops, [{
    op: "send",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "ls" },
    },
  }]);
}
{
  // unparseable arguments fall back to the raw string; edit tools advertise locations
  const ops = mapSessionEvent({
    type: "tool/call",
    data: { callId: "call-2", name: "edit", arguments: "{not json" },
  });
  const update = ops[0].update;
  assert.equal(update.kind, "edit");
  assert.equal(update.rawInput, "{not json");
}
{
  const ops = mapSessionEvent({
    type: "tool/call",
    data: { callId: "call-3", name: "write", arguments: '{"file_path":"a.txt","content":"x"}' },
  });
  assert.deepEqual(ops[0].update.locations, [{ path: "a.txt" }]);
}
{
  const ops = mapSessionEvent({
    type: "tool/call",
    data: { callId: "call-4", name: "glob", arguments: '{"pattern":"**/*.ts"}' },
  });
  assert.equal(ops[0].update.kind, "search");
  assert.equal(ops[0].update.locations, undefined);
}

// ---- tool/result: canonical content array + rawOutput ----
{
  const ops = mapSessionEvent({
    type: "tool/result",
    data: {
      message: {
        content: [{ content: [{ type: "text", text: "done" }], isError: false }],
        source: { callId: "call-1" },
      },
    },
  });
  assert.deepEqual(ops, [{
    op: "send",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "done" } }],
      rawOutput: "done",
    },
  }]);
}
{
  const ops = mapSessionEvent({
    type: "tool/result",
    data: {
      message: { content: [{ content: [], isError: true }], source: { callId: "call-2" } },
      error: { name: "ToolError", code: "E_BAD" },
    },
  });
  assert.deepEqual(ops, [{
    op: "send",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      status: "failed",
      content: undefined,
      rawOutput: "",
      title: "ToolError: E_BAD",
    },
  }]);
}

// ---- todo/write -> plan snapshot ----
{
  const ops = mapSessionEvent({
    type: "todo/write",
    data: {
      todos: [
        { content: "step one", status: "in_progress" },
        { content: "step two", status: "pending" },
        { content: "step three", status: "completed" },
      ],
    },
  });
  assert.deepEqual(ops, [{
    op: "send",
    update: {
      sessionUpdate: "plan",
      entries: [
        { title: "step one", status: "doing", priority: 0, subTasks: [] },
        { title: "step two", status: "todo", priority: 1, subTasks: [] },
        { title: "step three", status: "done", priority: 2, subTasks: [] },
      ],
    },
  }]);
}

// ---- unrelated events produce no ops ----
{
  for (const type of ["turn/start", "turn/end", "user/message", "step/start"]) {
    assert.deepEqual(mapSessionEvent({ type, data: {} }), [], type);
  }
}

console.log("EVENT-MAP TESTS PASSED");
process.exit(0);
