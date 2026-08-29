import type { Context } from "@deepseek-ai/cordis";
import { type SessionConfigOption, type SessionModeState, type StopReason } from "../acp/types.js";
import { type SessionUpdateMode, type UpdateSink } from "../acp/session-update-pump.js";
import type { PermissionChannel } from "./types.js";
/** Config-option ids advertised in session/new (pi-acp uses the same pair). */
export { MODEL_CONFIG_ID, THOUGHT_LEVEL_CONFIG_ID } from "./session-config.js";
/** Agent -> client permission channel (transport-agnostic). */
export type { PermissionChannel } from "./types.js";
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
export declare class DshAgentBridge {
    private readonly ctx;
    private readonly options;
    private readonly config;
    private readonly states;
    private readonly unsubscribe;
    private sink;
    private permissionChannel;
    private unsubscribeApproval;
    private readyPromise;
    constructor(ctx: Context, options?: DshAgentBridgeOptions);
    /**
     * Resolve once the Loader has settled, so the Agent factory (registered by
     * dsh-agent-loop during boot) is guaranteed present before the first create.
     * Mirrors dsh-headless's 'await ctx.get("loader")?.await()'.
     */
    private ensureReady;
    /** Attach the wire sink that receives ACP updates. */
    setSink(sink: UpdateSink): void;
    /**
     * Attach the agent -> client permission channel (the ACP server). Approval
     * asks only occur inside a running turn, i.e. after the server exists, so
     * wiring it here is safe even when construction order varies.
     */
    setPermissionChannel(channel: PermissionChannel): void;
    /** True when this bridge owns a live agent for the given ACP session id. */
    hasSession(sessionId: string): boolean;
    /** Create one fresh dsh Agent and register it under a new ACP session id. */
    createSession(cwd: string): Promise<string>;
    /** Stop and dispose one session's agent. */
    disposeSession(sessionId: string): Promise<void>;
    /** Dispose every live agent (fiber unload / transport close). */
    disposeAll(): Promise<void>;
    /**
     * Submit a plain-text user prompt. When a turn is already running the prompt
     * is queued FIFO and the client is told its queue position; the returned
     * promise resolves with that turn's stop reason once it settles.
     */
    prompt(sessionId: string, text: string): Promise<StopReason>;
    /** Cancel the active turn of one session without disposing it. */
    stop(sessionId: string): Promise<void>;
    /** Fire-and-forget cancel (ACP session/cancel is a notification). */
    cancel(sessionId: string): void;
    /**
     * Answer one `approval/request` waterfall entry by asking the ACP client for
     * a one-shot decision. Requests not owned by this bridge's sessions, or
     * without a tool-call id to correlate against (the ACP permission surface is
     * keyed on the tool call already streamed to the client), are delegated via
     * `next()` so any other composed answerer still gets the question.
     */
    private onApprovalRequest;
    /** Send one `session/request_permission` and fold the decision back. */
    private askPermission;
    /**
     * The session's advertised modes and configuration options (session/new
     * response fields). Failure to enumerate is contained: the session itself
     * still works, the selectors are simply sparser.
     */
    getSessionConfig(sessionId: string): Promise<{
        modes: SessionModeState;
        configOptions: SessionConfigOption[];
    }>;
    /**
     * Switch the session to another mode (dsh agent preset). Valid only while
     * the session has produced nothing — dsh's recompose swap-safety rule.
     * Emits current_mode_update, then refreshes the config options.
     */
    setMode(sessionId: string, modeId: string): Promise<void>;
    /**
     * Set one session configuration option ("model" / "thought_level").
     * Returns the full refreshed option list (set_config_option response).
     */
    setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<SessionConfigOption[]>;
    /**
     * Legacy/UNSTABLE compatibility surface: session/set_model. Same effect as
     * setConfigOption("model"), but the response is empty; the refreshed
     * options arrive via config_option_update.
     */
    setModel(sessionId: string, modelId: string): Promise<void>;
    private createAgent;
    /** Bump the epoch, clear queued prompts (resolved cancelled), cancel the turn. */
    private cancelLockstep;
    private clearQueue;
    /** Run one turn to quiescence, then start the next queued prompt. */
    private runTurn;
    private requireState;
    /** Route one durable event to the session's pump. */
    private onSessionEvent;
    /** Record a streamed (turn, step) marker, pruning old turns past the cap. */
    private rememberStreamedStep;
    /** Drop stream markers from turns older than the two most recent turns. */
    private pruneStreamedSteps;
    private accumulateUsage;
    /** Fold the last turn-end after firstSeq into an ACP stopReason. */
    private lastStopReason;
    /** Rebuild and push the full config-option list (config_option_update). */
    private emitConfigOptions;
    /** Detach the session/event listener and dispose every agent. */
    dispose(): void;
}
//# sourceMappingURL=dsh-agent-bridge.d.ts.map