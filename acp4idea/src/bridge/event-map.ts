/**
 * Map DeepSeek Harness session events onto ACP session/update notifications.
 *
 * dsh's event-sourced session log is the single source of truth; every append
 * is lossless JSON and reaches the bridge through the 'session/event' firehose.
 * This module is pure: one durable event in, zero or more ACP updates out. It
 * owns no state and never talks to the transport.
 *
 * @module acp4idea/bridge/event-map
 */
import type { TodoItem } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type {
  PlanUpdate,
  SessionUpdate,
  ToolCallStatus,
} from "../acp/types.js";

/** Cap a tool-result payload surfaced to the client (display only). */
const RESULT_MAX_CHARS = 2000;

/** Classify a dsh tool name into ACP's coarse tool-call kinds. */
function classifyTool(name: string): "use" | "edit" | "fetch" | "custom" {
  if (name === "write" || name === "edit" || name === "str_replace_editor") return "edit";
  if (name === "bash" || name === "pwsh" || name === "run_code") return "use";
  if (name === "web_search" || name === "web_fetch") return "fetch";
  return "custom";
}

/** Join the text blocks of one content list into a single string. */
function extractText(blocks: readonly ContentBlock[]): string {
  let out = "";
  for (const block of blocks) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function mapTodoStatus(status: TodoItem["status"]): PlanUpdate["entries"][number]["status"] {
  switch (status) {
    case "pending": return "todo";
    case "in_progress": return "doing";
    case "completed": return "done";
  }
}

/**
 * Map one durable session event to zero or more ACP session updates.
 *
 * - assistant/message -> agent_message_chunk (text) + agent_thought_chunk
 *   (reasoning), one update per non-empty block kind.
 * - tool/call         -> tool_call (in_progress)
 * - tool/result       -> tool_call_update (completed / failed)
 * - todo/write        -> plan (the whole-list snapshot)
 * - everything else   -> no client-visible update.
 */
export function mapSessionEvent(event: SessionEvent): SessionUpdate[] {
  switch (event.type) {
    case "assistant/message": {
      // ACP spec: each chunk update carries a SINGLE ContentBlock. Merge all
      // text blocks into one text block and all reasoning blocks into one
      // thinking block (JetBrains' kotlinx.serialization rejects arrays here).
      const updates: SessionUpdate[] = [];
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      for (const block of event.data.message.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "reasoning") {
          thinkingParts.push(block.text);
        }
      }
      if (thinkingParts.length > 0) {
        // ACP ContentBlock has no 'thinking' variant in the published schema —
        // carry reasoning text in a plain text block so every client (incl.
        // JetBrains' kotlinx.serialization) can deserialize the chunk.
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: thinkingParts.join("") },
        });
      }
      if (textParts.length > 0) {
        updates.push({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: textParts.join("") },
        });
      }
      return updates;
    }

    case "tool/call": {
      const { callId, name, arguments: rawArguments } = event.data;
      return [{
        sessionUpdate: "tool_call",
        toolCallId: String(callId),
        title: name,
        kind: classifyTool(name),
        status: { value: "in_progress" },
        content: rawArguments,
      }];
    }

    case "tool/result": {
      const { message, error } = event.data;
      const resultBlock = message.content[0];
      const resultText = resultBlock ? extractText(resultBlock.content) : "";
      const callId = String(message.source.callId);
      const failed = error != null || resultBlock?.isError === true;
      const status: ToolCallStatus = failed
        ? { value: "failed", error: error ? error.name + ": " + error.code : (resultText || "tool failed") }
        : { value: "completed" };
      return [{
        sessionUpdate: "tool_call_update",
        toolCallId: callId,
        status,
        content: truncate(resultText, RESULT_MAX_CHARS),
      }];
    }

    case "todo/write": {
      return [{
        sessionUpdate: "plan",
        entries: event.data.todos.map((item, index) => ({
          title: item.content,
          status: mapTodoStatus(item.status),
          priority: index,
          subTasks: [],
        })),
      }];
    }

    default:
      return [];
  }
}
