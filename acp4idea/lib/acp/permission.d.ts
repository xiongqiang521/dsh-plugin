import type { RequestPermissionParams, RequestPermissionResult } from "./types.js";
/** dsh's closed approval-outcome vocabulary (mirrors ApprovalOutcome). */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";
/**
 * Fold an ACP permission decision into dsh's closed outcome vocabulary.
 * 'allowed-once' is the only grant; a cancelled dialog, an unknown option id,
 * or a malformed payload all fail closed to their dsh counterparts.
 */
export declare function mapPermissionOutcome(result: RequestPermissionResult): ApprovalOutcome;
/**
 * Build the 'session/request_permission' request for one approval ask. The
 * embedded tool call reuses the id the bridge already streamed as a `tool_call`
 * update, so the client can attach the dialog to the call it saw.
 */
export declare function buildPermissionRequest(input: {
    sessionId: string;
    toolName: string;
    callId: string;
    reason?: string;
}): RequestPermissionParams;
//# sourceMappingURL=permission.d.ts.map