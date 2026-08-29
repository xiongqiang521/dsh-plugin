/**
 * Shared structural types for the dsh <-> ACP bridge.
 *
 * The bridge works against structural views of dsh services (`ctx.agentPresets`,
 * `ctx.llm`, `ctx.approval`) instead of importing the concrete packages, so it
 * composes cleanly in any profile and stays testable. This module owns those
 * views plus the per-session runtime state both the bridge and the
 * session-config service operate on.
 *
 * @module acp4idea/bridge/types
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import type {
  RequestPermissionParams,
  RequestPermissionResult,
  StopReason,
} from "../acp/types.js";
import type { SessionUpdatePump } from "../acp/session-update-pump.js";
import type { ApprovalOutcome } from "../acp/permission.js";

/** Structural view of ctx.agentPresets (dsh-agent-presets), kept dependency-free. */
export interface PresetsService {
  list(): Promise<AgentPresetLike[]>;
  resolve(id?: string): Promise<AgentPresetLike>;
  readonly defaultId: string;
  mount(agentCtx: Context, id?: string): Promise<AgentPresetLike>;
  recompose(agentCtx: Context, id: string): Promise<AgentPresetLike>;
}

/** One preset row, as surfaced by the presets service. */
export interface AgentPresetLike {
  id: string;
  name?: string;
  description?: string;
  broken?: string;
}

/** Structural view of ctx.llm's catalog surface (subset of LlmRuntime). */
export interface LlmCatalogLike {
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

/**
 * One `approval/request` waterfall entry as the bridge sees it. Structural view
 * of @deepseek-ai/dsh-user-approval's ApprovalRequest, kept dependency-free
 * like PresetsService/LlmCatalogLike above.
 */
export interface ApprovalRequestLike {
  readonly agent: Agent;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

/** The event-host surface the approval answerer registers on. */
export interface ApprovalEventHost {
  on(
    event: "approval/request",
    listener: (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> | void,
  ): () => boolean;
}

/**
 * Agent -> client permission channel. Transport-agnostic: the ACP server (which
 * owns the wire) implements it by sending `session/request_permission` and
 * awaiting the client's one-shot decision.
 */
export interface PermissionChannel {
  requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult>;
}

/** A queued session/prompt that has not started its turn yet. */
export interface QueuedTurn {
  text: string;
  resolve: (reason: StopReason) => void;
}

/** Per-session runtime state owned by the bridge. */
export interface SessionState {
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
