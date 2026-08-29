const DEFAULT_MODE = "coalesced";
const DEFAULT_FLUSH_DELAY_MS = 25;
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024;
export function parseSessionUpdateMode(value) {
    if (value === undefined || value === "coalesced")
        return "coalesced";
    if (value === "legacy")
        return "legacy";
    throw new Error('invalid sessionUpdateMode "' + value + '" (expected "coalesced" or "legacy")');
}
export class SessionUpdatePump {
    mode;
    flushDelayMs;
    maxBufferedBytes;
    sink;
    sessionId;
    bufferedChunk = null;
    flushTimer = null;
    lastDelivery = Promise.resolve();
    disposed = false;
    constructor(sink, sessionId, options = {}) {
        this.sink = sink;
        this.sessionId = sessionId;
        this.mode = options.mode ?? DEFAULT_MODE;
        this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
        this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    }
    /** Append a streamed assistant-message text delta. */
    appendAgentMessage(text) {
        this.appendStreamChunk({ kind: "agent-message", text, bytes: byteLength(text) });
    }
    /** Append a streamed reasoning text delta. */
    appendAgentThought(text) {
        this.appendStreamChunk({ kind: "agent-thought", text, bytes: byteLength(text) });
    }
    /**
     * Send one structural update. All earlier buffered stream content is flushed
     * first so ordering is preserved; the update itself is enqueued FIFO.
     */
    send(update) {
        if (this.disposed)
            return;
        this.flushBufferedChunk();
        this.enqueue(update);
    }
    /** Flush the current buffer and await every delivery queued so far. */
    async flush() {
        this.flushBufferedChunk();
        await this.lastDelivery;
    }
    /** Abandon buffered and queued delivery work (already-writing may complete). */
    dispose() {
        this.disposed = true;
        this.clearFlushTimer();
        this.bufferedChunk = null;
    }
    // -------------------------------------------------------------------------
    appendStreamChunk(next) {
        if (this.mode === "legacy") {
            this.send(toSessionUpdate(next));
            return;
        }
        this.appendCoalescedChunk(next);
    }
    appendCoalescedChunk(next) {
        if (this.disposed || next.text.length === 0)
            return;
        if (this.bufferedChunk && this.bufferedChunk.kind === next.kind) {
            if (this.bufferedChunk.bytes + next.bytes > this.maxBufferedBytes) {
                this.flushBufferedChunk();
                this.bufferedChunk = next;
                this.scheduleFlush();
            }
            else {
                this.bufferedChunk.text += next.text;
                this.bufferedChunk.bytes += next.bytes;
            }
        }
        else {
            this.flushBufferedChunk();
            this.bufferedChunk = next;
            this.scheduleFlush();
        }
        if (this.bufferedChunk.bytes >= this.maxBufferedBytes)
            this.flushBufferedChunk();
    }
    scheduleFlush() {
        this.flushTimer = setTimeout(() => this.flushBufferedChunk(), this.flushDelayMs);
        this.flushTimer.unref?.();
    }
    flushBufferedChunk() {
        const chunk = this.bufferedChunk;
        if (!chunk || this.disposed)
            return;
        this.bufferedChunk = null;
        this.clearFlushTimer();
        this.enqueue(toSessionUpdate(chunk));
    }
    clearFlushTimer() {
        if (!this.flushTimer)
            return;
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
    }
    enqueue(update) {
        this.lastDelivery = this.lastDelivery
            .then(() => {
            if (this.disposed)
                return;
            this.sink.sendUpdate(this.sessionId, update);
        })
            .catch(() => {
            // A disconnected client must not prevent the active prompt from settling.
        });
    }
}
function toSessionUpdate(chunk) {
    return chunk.kind === "agent-message"
        ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk.text } }
        : { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk.text } };
}
function byteLength(text) {
    return Buffer.byteLength(text, "utf8");
}
//# sourceMappingURL=session-update-pump.js.map