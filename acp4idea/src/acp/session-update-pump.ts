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

/** One buffered coalescible stream chunk. */
type BufferedChunk = {
  kind: "agent-message" | "agent-thought";
  text: string;
  bytes: number;
};

/** Pump mode: coalesced (default) batches; legacy sends every delta. */
export type SessionUpdateMode = "coalesced" | "legacy";

export interface SessionUpdatePumpOptions {
  mode?: SessionUpdateMode;
  flushDelayMs?: number;
  maxBufferedBytes?: number;
}

const DEFAULT_MODE: SessionUpdateMode = "coalesced";
const DEFAULT_FLUSH_DELAY_MS = 25;
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024;

export function parseSessionUpdateMode(value: string | undefined): SessionUpdateMode {
  if (value === undefined || value === "coalesced") return "coalesced";
  if (value === "legacy") return "legacy";
  throw new Error('invalid sessionUpdateMode "' + value + '" (expected "coalesced" or "legacy")');
}

/** The wire sink the pump delivers finished updates to. */
export interface UpdateSink {
  sendUpdate(sessionId: string, update: SessionUpdate): void;
}

export class SessionUpdatePump {
  private readonly mode: SessionUpdateMode;
  private readonly flushDelayMs: number;
  private readonly maxBufferedBytes: number;
  private readonly sink: UpdateSink;
  private readonly sessionId: string;

  private bufferedChunk: BufferedChunk | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDelivery: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    sink: UpdateSink,
    sessionId: string,
    options: SessionUpdatePumpOptions = {},
  ) {
    this.sink = sink;
    this.sessionId = sessionId;
    this.mode = options.mode ?? DEFAULT_MODE;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  /** Append a streamed assistant-message text delta. */
  appendAgentMessage(text: string): void {
    this.appendStreamChunk({ kind: "agent-message", text, bytes: byteLength(text) });
  }

  /** Append a streamed reasoning text delta. */
  appendAgentThought(text: string): void {
    this.appendStreamChunk({ kind: "agent-thought", text, bytes: byteLength(text) });
  }

  /**
   * Send one structural update. All earlier buffered stream content is flushed
   * first so ordering is preserved; the update itself is enqueued FIFO.
   */
  send(update: SessionUpdate): void {
    if (this.disposed) return;
    this.flushBufferedChunk();
    this.enqueue(update);
  }

  /** Flush the current buffer and await every delivery queued so far. */
  async flush(): Promise<void> {
    this.flushBufferedChunk();
    await this.lastDelivery;
  }

  /** Abandon buffered and queued delivery work (already-writing may complete). */
  dispose(): void {
    this.disposed = true;
    this.clearFlushTimer();
    this.bufferedChunk = null;
  }

  // -------------------------------------------------------------------------

  private appendStreamChunk(next: BufferedChunk): void {
    if (this.mode === "legacy") {
      this.send(toSessionUpdate(next));
      return;
    }
    this.appendCoalescedChunk(next);
  }

  private appendCoalescedChunk(next: BufferedChunk): void {
    if (this.disposed || next.text.length === 0) return;

    if (this.bufferedChunk && this.bufferedChunk.kind === next.kind) {
      if (this.bufferedChunk.bytes + next.bytes > this.maxBufferedBytes) {
        this.flushBufferedChunk();
        this.bufferedChunk = next;
        this.scheduleFlush();
      } else {
        this.bufferedChunk.text += next.text;
        this.bufferedChunk.bytes += next.bytes;
      }
    } else {
      this.flushBufferedChunk();
      this.bufferedChunk = next;
      this.scheduleFlush();
    }

    if (this.bufferedChunk.bytes >= this.maxBufferedBytes) this.flushBufferedChunk();
  }

  private scheduleFlush(): void {
    this.flushTimer = setTimeout(() => this.flushBufferedChunk(), this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  private flushBufferedChunk(): void {
    const chunk = this.bufferedChunk;
    if (!chunk || this.disposed) return;
    this.bufferedChunk = null;
    this.clearFlushTimer();
    this.enqueue(toSessionUpdate(chunk));
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private enqueue(update: SessionUpdate): void {
    this.lastDelivery = this.lastDelivery
      .then(() => {
        if (this.disposed) return;
        this.sink.sendUpdate(this.sessionId, update);
      })
      .catch(() => {
        // A disconnected client must not prevent the active prompt from settling.
      });
  }
}

function toSessionUpdate(chunk: BufferedChunk): SessionUpdate {
  return chunk.kind === "agent-message"
    ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk.text } }
    : { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk.text } };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
