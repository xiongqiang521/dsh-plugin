/**
 * Unit tests for the pure ACP permission-surface helpers: folding the client's
 * one-shot decision into dsh's closed ApprovalOutcome vocabulary and building
 * the session/request_permission payload (tool-call correlation + one-shot
 * options only).
 */
import assert from "node:assert/strict";
import { buildPermissionRequest, mapPermissionOutcome } from "../lib/acp/permission.js";

// ---- mapPermissionOutcome: one-shot selections, cancellation, fail-closed ----
{
  assert.equal(
    mapPermissionOutcome({ outcome: { outcome: "selected", optionId: "allow_once" } }),
    "allowed-once",
  );
  assert.equal(
    mapPermissionOutcome({ outcome: { outcome: "selected", optionId: "reject_once" } }),
    "rejected",
  );
  assert.equal(mapPermissionOutcome({ outcome: { outcome: "cancelled" } }), "cancelled");
}

// ---- mapPermissionOutcome: only allowed-once grants; everything else closes ----
{
  // dsh never persists rules, so always-variants and unknown ids fail closed
  assert.equal(
    mapPermissionOutcome({ outcome: { outcome: "selected", optionId: "allow_always" } }),
    "unavailable",
  );
  assert.equal(
    mapPermissionOutcome({ outcome: { outcome: "selected", optionId: "reject_always" } }),
    "unavailable",
  );
  assert.equal(mapPermissionOutcome({ outcome: { outcome: "selected", optionId: "nope" } }), "unavailable");
  assert.equal(mapPermissionOutcome({ outcome: {} }), "unavailable");
  assert.equal(mapPermissionOutcome(null), "unavailable");
}

// ---- buildPermissionRequest: correlates the already-streamed tool call ----
{
  const params = buildPermissionRequest({
    sessionId: "session-1",
    toolName: "bash",
    callId: "call-9",
    reason: "escalate to danger-full-access",
  });
  assert.equal(params.sessionId, "session-1");
  assert.deepEqual(params.toolCall, {
    sessionUpdate: "tool_call",
    toolCallId: "call-9",
    title: "bash",
    kind: "execute",
    status: "in_progress",
  });
  // one-shot options only — the seam grants at most one action
  assert.deepEqual(params.options, [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
  ]);
  assert.deepEqual(params._meta, { reason: "escalate to danger-full-access" });
}

// ---- buildPermissionRequest: no reason -> no _meta; kinds classify canonically ----
{
  const params = buildPermissionRequest({ sessionId: "session-1", toolName: "edit", callId: "call-10" });
  assert.equal(params._meta, undefined);
  assert.equal(params.toolCall.kind, "edit");
  const execute = buildPermissionRequest({ sessionId: "session-1", toolName: "str_replace_editor", callId: "call-11" });
  assert.equal(execute.toolCall.kind, "edit");
}

console.log("PERMISSION-MAP TESTS PASSED");
process.exit(0);
