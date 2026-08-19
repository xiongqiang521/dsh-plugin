/**
 * Bridge between ACP sessions and DeepSeek Harness agents.
 *
 * Owns one live Agent per ACP session, created through the core registry
 * (ctx.agents) exactly like dsh-headless does, and subscribes to the
 * 'session/event' firehose to stream each durable event out as ACP
 * session/update traffic. Per-session behavior mirrors pi-acp's adapter
 * design:
 *
 * - Each session owns a SessionUpdatePump: token-level `assistant/chunk`
 *   deltas are coalesced (25 ms / 8 KiB) instead of flooding the client with
 *   one notification per delta; structural updates act as FIFO barriers.
 * - Concurrent session/prompt calls are queued FIFO per session; the second
 *   turn only starts once the first settles, exactly like dsh's own inbox
 *   serializes turns, but with explicit queue depth feedback and
 *   cancellation semantics (cancel clears queued prompts).
 * - Token usage from `assistant/message` is accumulated per session and
 *   reported as an ACP usage_update after each turn.
 * - Session metadata (title from the first prompt, updatedAt on activity) is
 *   pushed as session_info_update.
 *
 * The bridge is transport-agnostic: it pushes updates to a caller-supplied
 * UpdateSink (the ACP server), which owns the wire.
 *
 * @module acp4idea/bridge/dsh-agent-bridge
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import type { StopReason } from "../acp/types.js";
import {
  SessionUpdatePump,
  type SessionUpdateMode,
  type UpdateSink,
} from "../acp/session-update-pump.js";
import { mapSessionEvent } from "./event-map.js";

/** Default context-window size (tokens) used for ACP usage_update. */
const DEFAULT_CONTEXT_WINDOW = 131072;
/** Default cap for the session title derived from the first prompt. */
const DEFAULT_MAX_TITLE_LENGTH = 48;

export interface DshAgentBridgeOptions {
  /** Optional durable agent preset id attached to created sessions. */
  agentPreset?: string;
  /** Session update pump mode: "coalesced" (default) or "legacy". */
  sessionUpdateMode?: SessionUpdateMode;
  /** Context-window size (tokens) advertised in usage_update. */
  contextWindow?: number;
  /** Max length of the derived session title. */
  maxTitleLength?: number;
}

/** Map a durable turn-end reason to the ACP stopReason vocabulary. */
function toStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case "completed": return "end_turn";
    case "aborted": return "cancelled";
    case "max-tokens": return "max_tokens";
    case "error": return "end_turn";
    case "blocked": return "end_turn";
    case "interrupted": return "end_turn";
    default: return "end_turn";
  }
}

/** A queued session/prompt that has not started its turn yet. */
interface QueuedTurn {
  text: string;
  resolve: (reason: StopReason) => void;
}

/** Per-session runtime state owned by the bridge. */
interface SessionState {
  sessionId: string;
  handle: AgentHandle;
  pump: SessionUpdatePump;
  /** (turn, step) pairs whose text/reasoning was already streamed as chunks. */
  streamedSteps: Set<string>;
  /** Cumulative billed tokens for usage_update. */
  usedTokens: number;
  /** Bumped by cancel/stop; turns observe it to abort before followup. */
  epoch: number;
  running: boolean;
  queue: QueuedTurn[];
  titleSet: boolean;
}

export class DshAgentBridge {
  private readonly ctx: Context;
  private readonly options: {
    agentPreset: string | undefined;
    sessionUpdateMode: SessionUpdateMode;
    contextWindow: number;
    maxTitleLength: number;
  };
  private readonly states = new Map<string, SessionState>();
  private readonly unsubscribe: () => boolean;
  private sink: UpdateSink | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(ctx: Context, options: DshAgentBridgeOptions = {}) {
    this.ctx = ctx;
    this.options = {
      agentPreset: options.agentPreset ?? undefined,
      sessionUpdateMode: options.sessionUpdateMode ?? "coalesced",
      contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTitleLength: options.maxTitleLength ?? DEFAULT_MAX_TITLE_LENGTH,
    };
    this.unsubscribe = ctx.on("session/event", (session, event) => {
      this.onSessionEvent(session, event);
    });
  }

  /**
   * Resolve once the Loader has settled, so the Agent factory (registered by
   * dsh-agent-loop during boot) is guaranteed present before the first create.
   * Mirrors dsh-headless's 'await ctx.get("loader")?.await()'.
   */
  private ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      const loader = this.ctx.get("loader") as { await?: () => Promise<unknown> } | undefined;
      this.readyPromise = Promise.resolve(loader?.await?.()).then(() => undefined);
    }
    return this.readyPromise;
  }

  /** Attach the wire sink that receives ACP updates. */
  setSink(sink: UpdateSink): void {
    this.sink = sink;
  }

  /** True when this bridge owns a live agent for the given ACP session id. */
  hasSession(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /** Create one fresh dsh Agent and register it under a new ACP session id. */
  async createSession(cwd: string): Promise<string> {
    await this.ensureReady();
    const sessionId = SessionId("session-" + randomUUID());
    const handle = await this.createAgent(sessionId, cwd);
    const key = String(sessionId);
    this.states.set(key, {
      sessionId: key,
      handle,
      pump: new SessionUpdatePump(this.sink ?? { sendUpdate: () => {} }, key, {
        mode: this.options.sessionUpdateMode,
      }),
      streamedSteps: new Set(),
      usedTokens: 0,
      epoch: 0,
      running: false,
      queue: [],
      titleSet: false,
    });
    return key;
  }

  /** Stop and dispose one session's agent. */
  async disposeSession(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.states.delete(sessionId);
    state.pump.dispose();
    await state.handle.dispose();
  }

  /** Dispose every live agent (fiber unload / transport close). */
  async disposeAll(): Promise<void> {
    const states = [...this.states.values()];
    this.states.clear();
    for (const state of states) state.pump.dispose();
    await Promise.allSettled(states.map((state) => state.handle.dispose()));
  }

  // -------------------------------------------------------------------------
  // Prompt driving
  // -------------------------------------------------------------------------

  /**
   * Submit a plain-text user prompt. When a turn is already running the prompt
   * is queued FIFO and the client is told its queue position; the returned
   * promise resolves with that turn's stop reason once it settles.
   */
  async prompt(sessionId: string, text: string): Promise<StopReason> {
    const state = this.requireState(sessionId);
    if (state.running) {
      return new Promise<StopReason>((resolve) => {
        state.queue.push({ text, resolve });
        state.pump.send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Queued message (position ${state.queue.length}).` },
        });
      });
    }
    return this.runTurn(state, text);
  }

  /** Cancel the active turn of one session without disposing it. */
  async stop(sessionId: string): Promise<void> {
    const state = this.requireState(sessionId);
    this.cancelLockstep(state);
    await state.handle.agent.whenIdle();
  }

  /** Fire-and-forget cancel (ACP session/cancel is a notification). */
  cancel(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.cancelLockstep(state);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async createAgent(sessionId: ReturnType<typeof SessionId>, cwd: string): Promise<AgentHandle> {
    const agents = this.ctx.get("agents");
    const defaultModel = this.ctx.get("agentDefaultModel");
    if (!agents || !defaultModel) {
      throw new Error("acp4idea: 'agents' / 'agentDefaultModel' services are not composed in this profile");
    }
    const selection = defaultModel.currentSelection();
    return agents.create({
      sessionId,
      meta: { cwd, agentPreset: this.options.agentPreset },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
      },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      },
    });
  }

  /** Bump the epoch, clear queued prompts (resolved cancelled), cancel the turn. */
  private cancelLockstep(state: SessionState): void {
    state.epoch += 1;
    this.clearQueue(state);
    state.handle.agent.cancel({ kind: "user" });
  }

  private clearQueue(state: SessionState): void {
    const queued = state.queue.splice(0, state.queue.length);
    for (const turn of queued) turn.resolve("cancelled");
    if (queued.length > 0) {
      state.pump.send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Cleared queued prompts." },
      });
    }
  }

  /** Run one turn to quiescence, then start the next queued prompt. */
  private async runTurn(state: SessionState, text: string): Promise<StopReason> {
    state.running = true;
    const startEpoch = state.epoch;
    try {
      const agent = state.handle.agent;

      if (!state.titleSet) {
        state.titleSet = true;
        state.pump.send({
          sessionUpdate: "session_info_update",
          title: deriveTitle(text, this.options.maxTitleLength),
        });
      }

      // Let any prior activity converge; never followup while a turn runs.
      await agent.whenIdle();
      // A cancel may have landed while we waited — do not start a fresh turn.
      if (state.epoch !== startEpoch) return "cancelled";

      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }));
      await agent.whenIdle();

      const reason = this.lastStopReason(agent, firstSeq);

      // Report accumulated token usage and touch session activity.
      if (state.usedTokens > 0) {
        state.pump.send({
          sessionUpdate: "usage_update",
          used: Math.min(state.usedTokens, this.options.contextWindow),
          size: this.options.contextWindow,
        });
      }
      state.pump.send({
        sessionUpdate: "session_info_update",
        updatedAt: new Date().toISOString(),
      });

      return reason;
    } finally {
      state.running = false;
      const next = state.queue.shift();
      if (next) {
        void this.runTurn(state, next.text).then(next.resolve, () => next.resolve("end_turn"));
      }
    }
  }

  private requireState(sessionId: string): SessionState {
    const state = this.states.get(sessionId);
    if (!state) throw new Error("unknown session: " + sessionId);
    return state;
  }

  /** Route one durable event to the session's pump. */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    const state = this.states.get(String(session.id));
    if (!state) return;
    const ops = mapSessionEvent(event);
    for (const op of ops) {
      switch (op.op) {
        case "append-text":
          state.streamedSteps.add(`${op.turn}:${op.step}`);
          state.pump.appendAgentMessage(op.text);
          break;
        case "append-thought":
          state.streamedSteps.add(`${op.turn}:${op.step}`);
          state.pump.appendAgentThought(op.text);
          break;
        case "assistant-message": {
          if (op.usage) this.accumulateUsage(state, op.usage);
          // Text was already streamed as chunks for this step — the assembled
          // message would duplicate it. Only the usage is consumed.
          if (state.streamedSteps.has(`${op.turn}:${op.step}`)) break;
          if (op.thinkingParts.length > 0) {
            state.pump.send({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: op.thinkingParts.join("") },
            });
          }
          if (op.textParts.length > 0) {
            state.pump.send({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: op.textParts.join("") },
            });
          }
          break;
        }
        case "send":
          state.pump.send(op.update);
          break;
      }
    }
  }

  private accumulateUsage(state: SessionState, usage: TokenUsage): void {
    state.usedTokens +=
      usage.inputTokens +
      usage.outputTokens +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0);
  }

  /** Fold the last turn-end after firstSeq into an ACP stopReason. */
  private lastStopReason(agent: Agent, firstSeq: number): StopReason {
    let reason: StopReason = "end_turn";
    for (const event of agent.session.events) {
      if (event.seq < firstSeq) continue;
      if (event.type === "turn/end") {
        reason = toStopReason(event.data.reason);
      }
    }
    return reason;
  }

  /** Detach the session/event listener and dispose every agent. */
  dispose(): void {
    this.unsubscribe();
    void this.disposeAll();
  }
}

/** Derive a human-readable session title from the first prompt. */
function deriveTitle(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat || "dsh session";
  return flat.slice(0, maxLength).trimEnd() + "…";
}
