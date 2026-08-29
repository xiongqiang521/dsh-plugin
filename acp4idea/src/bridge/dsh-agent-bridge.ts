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
 * - Approval: the bridge answers dsh's `approval/request` waterfall for the
 *   sessions it owns by asking the ACP client for a one-shot decision
 *   (`session/request_permission`), so tool-pipeline approval asks surface in
 *   the IDE instead of failing closed with "no approval channel is available".
 *   Asks without a tool-call id to correlate against are delegated via next().
 *
 * Execution mode and model selection are adapted to dsh's own concepts and
 * delegated to SessionConfigService (see session-config.ts):
 *
 * - ACP session modes map to dsh *agent presets* (ctx.agentPresets): session/new
 *   advertises the roster as availableModes, and session/set_mode re-links the
 *   session to another preset via `recompose` — only while the session has
 *   produced no content, which is dsh's swap-safety rule.
 * - The ACP model selector (config option "model") is driven by
 *   ctx.llm.listProviders()/listModels() and applied per session through a
 *   mutable ModelSelectionRef installed by `installModelSelection`, so a
 *   switch takes effect from the next step. "thought_level" maps to the
 *   selected model's reasoning efforts. `session/set_model` is kept as a
 *   legacy/UNSTABLE compatibility surface.
 *
 * The bridge is transport-agnostic: it pushes updates to a caller-supplied
 * UpdateSink (the ACP server), which owns the wire.
 *
 * @module acp4idea/bridge/dsh-agent-bridge
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import {
  ErrorCode,
  type RequestPermissionResult,
  type SessionConfigOption,
  type SessionModeState,
  type StopReason,
} from "../acp/types.js";
import { RpcRequestError } from "../acp/transport.js";
import {
  buildPermissionRequest,
  mapPermissionOutcome,
  type ApprovalOutcome,
} from "../acp/permission.js";
import {
  SessionUpdatePump,
  type SessionUpdateMode,
  type UpdateSink,
} from "../acp/session-update-pump.js";
import { mapSessionEvent } from "./event-map.js";
import {
  SessionConfigService,
  hasProducedContent,
  MODEL_CONFIG_ID,
  THOUGHT_LEVEL_CONFIG_ID,
} from "./session-config.js";
import type {
  ApprovalEventHost,
  ApprovalRequestLike,
  PermissionChannel,
  SessionState,
} from "./types.js";

/** Config-option ids advertised in session/new (pi-acp uses the same pair). */
export { MODEL_CONFIG_ID, THOUGHT_LEVEL_CONFIG_ID } from "./session-config.js";
/** Agent -> client permission channel (transport-agnostic). */
export type { PermissionChannel } from "./types.js";

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

/** Cap on remembered (turn, step) stream markers; older turns are pruned. */
const MAX_STREAMED_STEPS = 4096;

export class DshAgentBridge {
  private readonly ctx: Context;
  private readonly options: {
    agentPreset: string | undefined;
    sessionUpdateMode: SessionUpdateMode;
    contextWindow: number;
    maxTitleLength: number;
  };
  private readonly config: SessionConfigService;
  private readonly states = new Map<string, SessionState>();
  private readonly unsubscribe: () => boolean;
  private sink: UpdateSink | null = null;
  private permissionChannel: PermissionChannel | null = null;
  private unsubscribeApproval: (() => boolean) | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(ctx: Context, options: DshAgentBridgeOptions = {}) {
    this.ctx = ctx;
    this.options = {
      agentPreset: options.agentPreset ?? undefined,
      sessionUpdateMode: options.sessionUpdateMode ?? "coalesced",
      contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTitleLength: options.maxTitleLength ?? DEFAULT_MAX_TITLE_LENGTH,
    };
    this.config = new SessionConfigService(ctx);
    this.unsubscribe = ctx.on("session/event", (session, event) => {
      this.onSessionEvent(session, event);
    });
    // Answer dsh's approval seam for the sessions this bridge owns: tool-
    // pipeline asks surface in the IDE as ACP permission requests instead of
    // failing closed with "no approval channel is available". The listener is
    // registered unconditionally — without @deepseek-ai/dsh-user-approval
    // composed, the event never fires and this is a no-op.
    this.unsubscribeApproval = (ctx as unknown as ApprovalEventHost).on("approval/request", (req, next) =>
      this.onApprovalRequest(req, next),
    );
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

  /**
   * Attach the agent -> client permission channel (the ACP server). Approval
   * asks only occur inside a running turn, i.e. after the server exists, so
   * wiring it here is safe even when construction order varies.
   */
  setPermissionChannel(channel: PermissionChannel): void {
    this.permissionChannel = channel;
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
    const key = String(sessionId);

    const defaultModel = this.ctx.get("agentDefaultModel");
    const initial = defaultModel?.currentSelection();
    const selection: ModelSelectionRef = { current: initial, assembled: undefined };

    const { handle, presetId } = await this.createAgent(sessionId, cwd, selection);
    this.states.set(key, {
      sessionId: key,
      handle,
      pump: new SessionUpdatePump(this.sink ?? { sendUpdate: () => {} }, key, {
        mode: this.options.sessionUpdateMode,
      }),
      selection,
      presetId,
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
  // Approval (dsh user-approval seam -> ACP session/request_permission)
  // -------------------------------------------------------------------------

  /**
   * Answer one `approval/request` waterfall entry by asking the ACP client for
   * a one-shot decision. Requests not owned by this bridge's sessions, or
   * without a tool-call id to correlate against (the ACP permission surface is
   * keyed on the tool call already streamed to the client), are delegated via
   * `next()` so any other composed answerer still gets the question.
   */
  private onApprovalRequest(
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const state = req.callId ? this.states.get(String(req.agent.session.id)) : undefined;
    if (!state || !this.permissionChannel) return next();
    if (req.signal?.aborted) return Promise.resolve("cancelled");
    return this.askPermission(state, req).catch(() => "unavailable");
  }

  /** Send one `session/request_permission` and fold the decision back. */
  private askPermission(state: SessionState, req: ApprovalRequestLike): Promise<ApprovalOutcome> {
    const channel = this.permissionChannel;
    if (!channel) return Promise.resolve("unavailable");
    let pending: Promise<RequestPermissionResult>;
    try {
      pending = channel.requestPermission(buildPermissionRequest({
        sessionId: state.sessionId,
        toolName: req.toolName,
        callId: String(req.callId),
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
      }));
    } catch {
      return Promise.resolve("unavailable");
    }
    const signal = req.signal;
    if (!signal) return pending.then(mapPermissionOutcome, () => "unavailable");
    // The approval service already resolves 'cancelled' when the request signal
    // aborts (turn cancelled); stop waiting on the wire at the same time so the
    // pending request is not left dangling after the turn went away.
    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish("cancelled");
      if (signal.aborted) {
        finish("cancelled");
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (result) => finish(mapPermissionOutcome(result)),
        () => finish("unavailable"),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Execution mode (dsh agent presets) and model selection
  // -------------------------------------------------------------------------

  /**
   * The session's advertised modes and configuration options (session/new
   * response fields). Failure to enumerate is contained: the session itself
   * still works, the selectors are simply sparser.
   */
  async getSessionConfig(sessionId: string): Promise<{
    modes: SessionModeState;
    configOptions: SessionConfigOption[];
  }> {
    const state = this.requireState(sessionId);
    const [modes, configOptions] = await Promise.all([
      this.config.readModes(state),
      this.config.buildConfigOptions(state),
    ]);
    return { modes, configOptions };
  }

  /**
   * Switch the session to another mode (dsh agent preset). Valid only while
   * the session has produced nothing — dsh's recompose swap-safety rule.
   * Emits current_mode_update, then refreshes the config options.
   */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    const state = this.requireState(sessionId);
    const presets = this.config.presets();
    if (!presets) {
      throw new RpcRequestError(ErrorCode.InvalidParams, "modes unavailable: no agent-presets service");
    }
    const modes = await this.config.readModes(state);
    if (!modes.availableModes.some((mode) => mode.id === modeId)) {
      throw new RpcRequestError(ErrorCode.InvalidParams, "unknown modeId: " + modeId);
    }
    if (hasProducedContent(state.handle.agent.session)) {
      throw new RpcRequestError(
        ErrorCode.InvalidParams,
        "cannot switch mode: the session already produced content",
      );
    }
    const preset = await presets.recompose(state.handle.agent.ctx, modeId);
    state.presetId = preset.id;
    state.pump.send({ sessionUpdate: "current_mode_update", currentModeId: preset.id });
    await this.emitConfigOptions(state);
  }

  /**
   * Set one session configuration option ("model" / "thought_level").
   * Returns the full refreshed option list (set_config_option response).
   */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<SessionConfigOption[]> {
    const state = this.requireState(sessionId);
    if (configId === MODEL_CONFIG_ID) {
      if (typeof value !== "string") {
        throw new RpcRequestError(ErrorCode.InvalidParams, "model value must be a string");
      }
      await this.config.applyModel(state, value);
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (typeof value !== "string") {
        throw new RpcRequestError(ErrorCode.InvalidParams, "thought_level value must be a string");
      }
      await this.config.applyThoughtLevel(state, value);
    } else {
      throw new RpcRequestError(ErrorCode.InvalidParams, "unknown config option: " + configId);
    }
    const configOptions = await this.config.buildConfigOptions(state);
    state.pump.send({ sessionUpdate: "config_option_update", configOptions });
    return configOptions;
  }

  /**
   * Legacy/UNSTABLE compatibility surface: session/set_model. Same effect as
   * setConfigOption("model"), but the response is empty; the refreshed
   * options arrive via config_option_update.
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    const state = this.requireState(sessionId);
    await this.config.applyModel(state, modelId);
    await this.emitConfigOptions(state);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async createAgent(
    sessionId: ReturnType<typeof SessionId>,
    cwd: string,
    selection: ModelSelectionRef,
  ): Promise<{ handle: AgentHandle; presetId: string | null }> {
    const agents = this.ctx.get("agents");
    const defaultModel = this.ctx.get("agentDefaultModel");
    if (!agents || !defaultModel) {
      throw new Error("acp4idea: 'agents' / 'agentDefaultModel' services are not composed in this profile");
    }
    let presetId: string | null = null;
    const handle = await agents.create({
      sessionId,
      meta: { cwd, agentPreset: this.options.agentPreset },
      agentOptions: {
        provider: selection.current?.provider,
        model: selection.current?.model,
      },
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, selection);
        const presets = this.config.presets();
        if (presets) {
          const preset = await presets.mount(agentCtx, this.options.agentPreset);
          presetId = preset.id;
        }
      },
    });
    return { handle, presetId };
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
        const size = state.contextWindow ?? this.options.contextWindow;
        state.pump.send({
          sessionUpdate: "usage_update",
          used: Math.min(state.usedTokens, size),
          size,
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
    if (!state) {
      throw new RpcRequestError(ErrorCode.InvalidParams, "unknown session: " + sessionId);
    }
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
          this.rememberStreamedStep(state, op.turn, op.step);
          state.pump.appendAgentMessage(op.text);
          break;
        case "append-thought":
          this.rememberStreamedStep(state, op.turn, op.step);
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

  /** Record a streamed (turn, step) marker, pruning old turns past the cap. */
  private rememberStreamedStep(state: SessionState, turn: number, step: number): void {
    state.streamedSteps.add(`${turn}:${step}`);
    if (state.streamedSteps.size > MAX_STREAMED_STEPS) this.pruneStreamedSteps(state);
  }

  /** Drop stream markers from turns older than the two most recent turns. */
  private pruneStreamedSteps(state: SessionState): void {
    let maxTurn = 0;
    for (const key of state.streamedSteps) {
      const turn = Number(key.slice(0, key.indexOf(":")));
      if (turn > maxTurn) maxTurn = turn;
    }
    if (maxTurn <= 2) return;
    const keepFrom = maxTurn - 2;
    for (const key of state.streamedSteps) {
      if (Number(key.slice(0, key.indexOf(":"))) < keepFrom) state.streamedSteps.delete(key);
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

  /** Rebuild and push the full config-option list (config_option_update). */
  private async emitConfigOptions(state: SessionState): Promise<void> {
    const configOptions = await this.config.buildConfigOptions(state);
    state.pump.send({ sessionUpdate: "config_option_update", configOptions });
  }

  /** Detach the session/event listener and dispose every agent. */
  dispose(): void {
    this.unsubscribe();
    this.unsubscribeApproval?.();
    void this.disposeAll();
  }
}

/** Derive a human-readable session title from the first prompt. */
function deriveTitle(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat || "dsh session";
  return flat.slice(0, maxLength).trimEnd() + "…";
}
