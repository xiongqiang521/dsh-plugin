/**
 * dsh tool name -> canonical ACP ToolKind classifier.
 *
 * Pure and shared by both protocol-facing code (permission requests embed the
 * kind of the tool being approved) and the bridge event mapper (tool_call /
 * tool_call_update construction). Lives in the acp layer — not in the bridge —
 * so protocol code never depends upward on the bridge.
 *
 * @module acp4idea/acp/tool-kind
 */
import type { ToolKind } from "./types.js";
/** Classify a dsh tool name into the canonical ACP ToolKind vocabulary. */
export declare function classifyTool(name: string): ToolKind;
//# sourceMappingURL=tool-kind.d.ts.map