import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import type { SessionUpdate } from "../acp/types.js";
/**
 * A structured op produced from one durable event.
 *
 * - append-text / append-thought: token-level stream deltas the bridge feeds to
 *   the coalescing pump (never sent one-per-event).
 * - assistant-message: the assembled per-step message plus its token usage. The
 *   bridge emits its text only when no chunks were streamed for that step (e.g.
 *   replay), and always accumulates the usage.
 * - send: a complete structural update (tool_call, plan, ...) to deliver FIFO.
 */
export type MappedOp = {
    op: "append-text";
    turn: number;
    step: number;
    text: string;
} | {
    op: "append-thought";
    turn: number;
    step: number;
    text: string;
} | {
    op: "assistant-message";
    turn: number;
    step: number;
    textParts: string[];
    thinkingParts: string[];
    usage?: TokenUsage;
} | {
    op: "send";
    update: SessionUpdate;
};
/**
 * Map one durable session event to zero or more structured ops.
 *
 * - assistant/chunk    -> append-text / append-thought (stream deltas)
 * - assistant/message  -> assistant-message (assembled text + usage)
 * - tool/call          -> send tool_call (in_progress)
 * - tool/result        -> send tool_call_update (completed / failed)
 * - todo/write         -> send plan (whole-list snapshot)
 * - everything else    -> no op
 */
export declare function mapSessionEvent(event: SessionEvent): MappedOp[];
//# sourceMappingURL=event-map.d.ts.map