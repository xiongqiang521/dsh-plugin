/**
 * SessionUpdatePump — coalescing pump for streamed ACP session updates.
 *
 * dsh emits `assistant/chunk` deltas at token granularity; an ACP client such
 * as IDEA or Zed renders each session/update notification, so one notification
 * per token floods the client with serialization and rendering work. This pump
 * (adapted from pi-acp's SessionUpdatePump) groups compatible stream chunks by
 * time and byte limits without changing the concatenated content or the
 * observable event order:
 *
 * - Only consecutive chunks of the same semantic kind (message text vs.
 *   reasoning text) may be coalesced into one buffer.
 * - `send()` is an ordering barrier: buffered stream content is enqueued
 *   BEFORE the structural update (tool_call, plan, usage, ...), so a client
 *   never sees a tool start before the text that preceded it.
 * - `flush()` enqueues the current buffer and waits for every delivery queued
 *   before the call — prompt responses only resolve after their stream fully
 *   reached the wire.
 * - `dispose()` abandons buffered and not-yet-started delivery work.
 * - Delivery failures are contained here: a disconnected client cannot leave
 *   an ACP prompt permanently unsettled.
 *
 * `legacy` mode (diagnostic / A/B) sends every delta as its own notification.
 *
 * @module acp4idea/acp/session-update-pump
 */
import type { SessionUpdate } from "./types.js";
/** Pump mode: coalesced (default) batches; legacy sends every delta. */
export type SessionUpdateMode = "coalesced" | "legacy";
export interface SessionUpdatePumpOptions {
    mode?: SessionUpdateMode;
    flushDelayMs?: number;
    maxBufferedBytes?: number;
}
export declare function parseSessionUpdateMode(value: string | undefined): SessionUpdateMode;
/** The wire sink the pump delivers finished updates to. */
export interface UpdateSink {
    sendUpdate(sessionId: string, update: SessionUpdate): void;
}
export declare class SessionUpdatePump {
    private readonly mode;
    private readonly flushDelayMs;
    private readonly maxBufferedBytes;
    private readonly sink;
    private readonly sessionId;
    private bufferedChunk;
    private flushTimer;
    private lastDelivery;
    private disposed;
    constructor(sink: UpdateSink, sessionId: string, options?: SessionUpdatePumpOptions);
    /** Append a streamed assistant-message text delta. */
    appendAgentMessage(text: string): void;
    /** Append a streamed reasoning text delta. */
    appendAgentThought(text: string): void;
    /**
     * Send one structural update. All earlier buffered stream content is flushed
     * first so ordering is preserved; the update itself is enqueued FIFO.
     */
    send(update: SessionUpdate): void;
    /** Flush the current buffer and await every delivery queued so far. */
    flush(): Promise<void>;
    /** Abandon buffered and queued delivery work (already-writing may complete). */
    dispose(): void;
    private appendStreamChunk;
    private appendCoalescedChunk;
    private scheduleFlush;
    private flushBufferedChunk;
    private clearFlushTimer;
    private enqueue;
}
//# sourceMappingURL=session-update-pump.d.ts.map