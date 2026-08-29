/**
 * ACP permission-request surface (`session/request_permission`) helpers.
 *
 * dsh's tool pipeline asks for one-shot human approval through the
 * `approval/request` waterfall (`ctx.approval`, @deepseek-ai/dsh-user-approval).
 * This module is the pure, dsh-agnostic half of the ACP answerer: it builds the
 * agent -> client permission request (correlated with the `tool_call` already
 * streamed as a session/update) and folds the client's one-shot decision back
 * into dsh's closed `ApprovalOutcome` vocabulary. The bridge wires these
 * helpers to the waterfall; nothing here imports dsh services, so the mapping
 * stays unit-testable without composing a Cordis context.
 *
 * Only one-shot options (`allow_once` / `reject_once`) are advertised: dsh's
 * approval seam grants at most one action and never remembers rules, so
 * offering `allow_always` / `reject_always` would promise persistence dsh does
 * not have. Any other selected option id fails closed to 'unavailable'.
 *
 * @module acp4idea/acp/permission
 */
import { classifyTool } from "./tool-kind.js";
import type {
  PermissionOption,
  RequestPermissionParams,
  RequestPermissionResult,
  ToolCallUpdate,
} from "./types.js";

/** dsh's closed approval-outcome vocabulary (mirrors ApprovalOutcome). */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/**
 * Fold an ACP permission decision into dsh's closed outcome vocabulary.
 * 'allowed-once' is the only grant; a cancelled dialog, an unknown option id,
 * or a malformed payload all fail closed to their dsh counterparts.
 */
export function mapPermissionOutcome(result: RequestPermissionResult): ApprovalOutcome {
  const outcome = result?.outcome;
  if (!outcome || typeof outcome !== "object") return "unavailable";
  if (outcome.outcome === "cancelled") return "cancelled";
  if (outcome.outcome === "selected" && typeof outcome.optionId === "string") {
    switch (outcome.optionId) {
      case "allow_once": return "allowed-once";
      case "reject_once": return "rejected";
    }
  }
  return "unavailable";
}

/**
 * Build the 'session/request_permission' request for one approval ask. The
 * embedded tool call reuses the id the bridge already streamed as a `tool_call`
 * update, so the client can attach the dialog to the call it saw.
 */
export function buildPermissionRequest(input: {
  sessionId: string;
  toolName: string;
  callId: string;
  reason?: string;
}): RequestPermissionParams {
  const toolCall: ToolCallUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: input.callId,
    title: input.toolName,
    kind: classifyTool(input.toolName),
    status: "in_progress",
  };
  const options: PermissionOption[] = [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
  ];
  return {
    sessionId: input.sessionId,
    toolCall,
    options,
    // v1 has no top-level reason field; carry the asker's explanation as an
    // _meta extension (the spec reserves _meta for exactly this purpose).
    ...(input.reason !== undefined ? { _meta: { reason: input.reason } } : {}),
  };
}
