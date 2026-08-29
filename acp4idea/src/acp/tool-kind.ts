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
export function classifyTool(name: string): ToolKind {
  if (name === "write" || name === "edit" || name === "str_replace_editor" || name === "apply_patch") return "edit";
  if (name === "bash" || name === "pwsh" || name === "run_code") return "execute";
  if (name === "read" || name === "read_text_file" || name === "read_image" || name === "describe_image") return "read";
  if (name === "glob" || name === "grep" || name === "ls" || name === "search") return "search";
  if (name === "web_search" || name === "web_fetch" || name === "http_get") return "fetch";
  if (name === "rm" || name === "delete") return "delete";
  if (name === "move" || name === "rename") return "move";
  if (name === "think") return "think";
  return "other";
}
