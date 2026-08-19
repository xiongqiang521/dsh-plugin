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
 * Execution mode and model selection are adapted to dsh's own concepts:
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
import type { ReasoningEffortId, TokenUsage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import {
  ErrorCode,
  type SessionConfigOption,
  type SessionMode,
  type SessionModeState,
  type StopReason,
} from "../acp/types.js";
import { RpcRequestError } from "../acp/transport.js";
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

/** Config-option ids advertised in session/new (pi-acp uses the same pair). */
export const MODEL_CONFIG_ID = "model";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

/** Structural view of ctx.agentPresets (dsh-agent-presets), kept dependency-free. */
interface PresetsService {
  list(): Promise<AgentPresetLike[]>;
  resolve(id?: string): Promise<AgentPresetLike>;
  readonly defaultId: string;
  mount(agentCtx: Context, id?: string): Promise<AgentPresetLike>;
  recompose(agentCtx: Context, id: string): Promise<AgentPresetLike>;
}

/** One preset row, as surfaced by the presets service. */
interface AgentPresetLike {
  id: string;
  name?: string;
  description?: string;
  broken?: string;
}

/** Structural view of ctx.llm's catalog surface (subset of LlmRuntime). */
interface LlmCatalogLike {
  listProviders(): { id: string; name: string }[];
  listModels(provider: string): Promise<{ provider: string; id: string; name: string; description?: string }[]>;
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    context?: { contextWindow?: number };
    reasoning?: {
      efforts: { id: string; name: string; description?: string }[];
      defaultEffort?: string;
    };
  }>;
}

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
  /** Mutable model selection consumed by installModelSelection. */
  selection: ModelSelectionRef;
  /** Preset (ACP mode) the session was composed from, when any. */
  presetId: string | null;
  /** (turn, step) pairs whose text/reasoning was already streamed as chunks. */
  streamedSteps: Set<string>;
  /** Cumulative billed tokens for usage_update. */
  usedTokens: number;
  /** Resolved context-window size of the current model, when known. */
  contextWindow?: number;
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
      this.readModes(state),
      this.buildConfigOptions(state),
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
    const presets = this.ctx.get("agentPresets") as PresetsService | undefined;
    if (!presets) {
      throw new RpcRequestError(ErrorCode.InvalidParams, "modes unavailable: no agent-presets service");
    }
    const modes = await this.readModes(state);
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
      await this.applyModel(state, value);
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (typeof value !== "string") {
        throw new RpcRequestError(ErrorCode.InvalidParams, "thought_level value must be a string");
      }
      await this.applyThoughtLevel(state, value);
    } else {
      throw new RpcRequestError(ErrorCode.InvalidParams, "unknown config option: " + configId);
    }
    const configOptions = await this.buildConfigOptions(state);
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
    await this.applyModel(state, modelId);
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
        const presets = this.ctx.get("agentPresets") as PresetsService | undefined;
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

  // -------------------------------------------------------------------------
  // Mode + model enumeration helpers
  // -------------------------------------------------------------------------

  private presets(): PresetsService | undefined {
    return this.ctx.get("agentPresets") as PresetsService | undefined;
  }

  private llm(): LlmCatalogLike | undefined {
    return this.ctx.get("llm") as LlmCatalogLike | undefined;
  }

  /** ACP modes = the deployment's agent-preset roster. */
  private async readModes(state: SessionState): Promise<SessionModeState> {
    const presets = this.presets();
    if (!presets) {
      return { currentModeId: state.presetId ?? "default", availableModes: [] };
    }
    let availableModes: SessionMode[];
    try {
      availableModes = (await presets.list())
        .filter((preset) => !preset.broken)
        .map((preset) => ({
          id: preset.id,
          name: preset.name ?? preset.id,
          description: preset.description ?? null,
        }));
    } catch {
      availableModes = [];
    }
    let currentModeId = state.presetId;
    if (!currentModeId) {
      try {
        currentModeId = (await presets.resolve()).id;
      } catch {
        currentModeId = availableModes[0]?.id ?? "default";
      }
    }
    return { currentModeId, availableModes };
  }

  /** The full ACP config-option list for one session (model + thought level). */
  private async buildConfigOptions(state: SessionState): Promise<SessionConfigOption[]> {
    const options: SessionConfigOption[] = [];

    const modelState = await this.readModelState(state);
    if (modelState) {
      options.push({
        type: "select",
        id: MODEL_CONFIG_ID,
        category: "model",
        name: "Model",
        description: "Select the model for this session",
        currentValue: modelState.currentModelId,
        options: modelState.availableModels.map((model) => ({
          value: model.modelId,
          name: model.name,
          description: model.description ?? null,
        })),
      });
    }

    const thoughtState = await this.readThoughtLevels(state);
    if (thoughtState) {
      options.push({
        type: "select",
        id: THOUGHT_LEVEL_CONFIG_ID,
        category: "thought_level",
        name: "Thinking",
        description: "Set the reasoning effort for this session",
        currentValue: thoughtState.currentEffort,
        options: thoughtState.efforts.map((effort) => ({
          value: effort.id,
          name: effort.name,
          description: effort.description ?? null,
        })),
      });
    }

    return options;
  }

  /** Enumerate every registered provider's models plus the current selection. */
  private async readModelState(state: SessionState): Promise<{
    availableModels: { modelId: string; name: string; description?: string }[];
    currentModelId: string;
  } | null> {
    const current = state.selection.current;
    if (!current) return null;
    const currentModelId = modelIdOf(current.provider, current.model);

    const models: { modelId: string; name: string; description?: string }[] = [];
    const llm = this.llm();
    if (llm) {
      const providers = llm.listProviders();
      const lists = await Promise.allSettled(providers.map((provider) => llm.listModels(provider.id)));
      for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        const result = lists[i];
        if (result.status !== "fulfilled") continue;
        for (const model of result.value) {
          models.push({
            modelId: modelIdOf(provider.id, model.id),
            name: `${provider.name}/${model.name ?? model.id}`,
            description: model.description,
          });
        }
      }
    }

    // Always surface the active selection, even when its route is not
    // enumerable (e.g. an adapter with no live catalog).
    if (!models.some((model) => model.modelId === currentModelId)) {
      models.unshift({
        modelId: currentModelId,
        name: `${current.provider}/${current.model}`,
        description: "Currently selected model",
      });
    }

    return { availableModels: models, currentModelId };
  }

  /** Selectable reasoning efforts of the currently selected model. */
  private async readThoughtLevels(state: SessionState): Promise<{
    efforts: { id: string; name: string; description?: string }[];
    currentEffort: string;
  } | null> {
    const current = state.selection.current;
    const llm = this.llm();
    if (!current || !llm) return null;
    let efforts: { id: string; name: string; description?: string }[] = [];
    let defaultEffort: string | undefined;
    try {
      const info = await llm.resolveModelInfo(current.provider, current.model);
      // Advertise the model's real context window in usage_update when known.
      const window = info.context?.contextWindow;
      if (typeof window === "number" && Number.isFinite(window) && window > 0) {
        state.contextWindow = window;
      }
      efforts = (info.reasoning?.efforts ?? []).map((effort) => ({
        id: String(effort.id),
        name: effort.name,
        description: effort.description,
      }));
      defaultEffort = info.reasoning?.defaultEffort !== undefined ? String(info.reasoning.defaultEffort) : undefined;
    } catch {
      return null;
    }
    if (efforts.length === 0) return null;

    const selected =
      current.reasoningEffort !== undefined ? String(current.reasoningEffort) : defaultEffort;
    return {
      efforts,
      currentEffort: selected ?? efforts[0].id,
    };
  }

  /** Apply a modelId ("provider/model") to the session's mutable selection. */
  private async applyModel(state: SessionState, modelId: string): Promise<void> {
    const { provider, model } = parseModelId(modelId);
    const llm = this.llm();
    if (llm) {
      const providers = llm.listProviders();
      if (!providers.some((entry) => entry.id === provider)) {
        throw new RpcRequestError(ErrorCode.InvalidParams, "unknown provider: " + provider);
      }
      const catalog = await llm.listModels(provider).catch(() => null);
      if (catalog && !catalog.some((entry) => entry.id === model)) {
        throw new RpcRequestError(ErrorCode.InvalidParams, "unknown model: " + modelId);
      }
    }
    // A new model's reasoning vocabulary may differ — drop the old effort and
    // re-resolve the context window at the next enumeration.
    state.selection.current = { provider, model };
    state.contextWindow = undefined;
  }

  /** Apply a reasoning-effort id to the session's mutable selection. */
  private async applyThoughtLevel(state: SessionState, effortId: string): Promise<void> {
    const current = state.selection.current;
    if (!current) {
      throw new RpcRequestError(ErrorCode.InvalidParams, "no model selected");
    }
    const llm = this.llm();
    let valid = true;
    if (llm) {
      try {
        const info = await llm.resolveModelInfo(current.provider, current.model);
        valid = (info.reasoning?.efforts ?? []).some((effort) => String(effort.id) === effortId);
      } catch {
        valid = true; // un-resolvable catalog: accept and let the adapter judge
      }
    }
    if (!valid) {
      throw new RpcRequestError(ErrorCode.InvalidParams, "unknown thought level: " + effortId);
    }
    state.selection.current = { ...current, reasoningEffort: effortId as ReasoningEffortId };
  }

  /** Rebuild and push the full config-option list (config_option_update). */
  private async emitConfigOptions(state: SessionState): Promise<void> {
    const configOptions = await this.buildConfigOptions(state);
    state.pump.send({ sessionUpdate: "config_option_update", configOptions });
  }

  /** Detach the session/event listener and dispose every agent. */
  dispose(): void {
    this.unsubscribe();
    void this.disposeAll();
  }
}

/** Encode one provider/model pair as an ACP model-id. */
function modelIdOf(provider: string, model: string): string {
  return provider + "/" + model;
}

/** Decode an ACP model-id ("provider/model") back into its parts. */
function parseModelId(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    throw new RpcRequestError(ErrorCode.InvalidParams, "invalid modelId (expected provider/model): " + modelId);
  }
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

/** Whether a session carries model-visible conversation content (seed and
 * lifecycle markers do not count — only actual prompts, model output, tool
 * work, or a closed turn do). */
function hasProducedContent(session: Session): boolean {
  return session.events.some(
    (event) =>
      event.type === "user/message" ||
      event.type === "assistant/message" ||
      event.type === "tool/result" ||
      event.type === "turn/end",
  );
}

/** Derive a human-readable session title from the first prompt. */
function deriveTitle(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat || "dsh session";
  return flat.slice(0, maxLength).trimEnd() + "…";
}
