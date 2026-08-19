/**
 * Bridge between ACP sessions and DeepSeek Harness agents.
 *
 * Owns one live Agent per ACP session, created through the core registry
 * (ctx.agents) exactly like dsh-headless does, and subscribes to the
 * 'session/event' firehose to stream each durable event out as an ACP
 * session/update. The bridge is transport-agnostic: it pushes updates to a
 * caller-supplied UpdateSink (the ACP server), which owns the wire.
 *
 * @module acp4idea/bridge/dsh-agent-bridge
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import type { SessionUpdate, StopReason } from "../acp/types.js";
import { mapSessionEvent } from "./event-map.js";

/** Sink for ACP session updates — implemented by the ACP server. */
export interface UpdateSink {
  sendUpdate(sessionId: string, update: SessionUpdate): void;
}

export interface DshAgentBridgeOptions {
  /** Optional durable agent preset id attached to created sessions. */
  agentPreset?: string;
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

export class DshAgentBridge {
  private readonly ctx: Context;
  private readonly options: DshAgentBridgeOptions;
  private readonly handles = new Map<string, AgentHandle>();
  private readonly unsubscribe: () => boolean;
  private sink: UpdateSink | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(ctx: Context, options: DshAgentBridgeOptions = {}) {
    this.ctx = ctx;
    this.options = options;
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
    return this.handles.has(sessionId);
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /** Create one fresh dsh Agent and register it under a new ACP session id. */
  async createSession(cwd: string): Promise<string> {
    await this.ensureReady();
    const sessionId = SessionId("session-" + randomUUID());
    const handle = await this.createAgent(sessionId, cwd);
    this.handles.set(String(sessionId), handle);
    return String(sessionId);
  }

  /** Stop and dispose one session's agent. */
  async disposeSession(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    this.handles.delete(sessionId);
    await handle.dispose();
  }

  /** Dispose every live agent (fiber unload / transport close). */
  async disposeAll(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.allSettled(handles.map((handle) => handle.dispose()));
  }

  // -------------------------------------------------------------------------
  // Prompt driving
  // -------------------------------------------------------------------------

  /**
   * Submit a plain-text user prompt as one follow-up turn and wait for
   * quiescence, streaming every durable event to the sink along the way.
   */
  async prompt(sessionId: string, text: string): Promise<StopReason> {
    const agent = this.requireAgent(sessionId);
    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();
    return this.lastStopReason(agent, firstSeq);
  }

  /** Cancel the active turn of one session without disposing it. */
  async stop(sessionId: string): Promise<void> {
    const agent = this.requireAgent(sessionId);
    agent.cancel({ kind: "user" });
    await agent.whenIdle();
  }

  /** Fire-and-forget cancel (ACP session/cancel is a notification). */
  cancel(sessionId: string): void {
    this.handles.get(sessionId)?.agent.cancel({ kind: "user" });
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

  private requireAgent(sessionId: string): Agent {
    const handle = this.handles.get(sessionId);
    if (!handle) throw new Error("unknown session: " + sessionId);
    return handle.agent;
  }

  /** Stream one durable event to the sink as ACP updates. */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (!this.sink || !this.handles.has(String(session.id))) return;
    const updates = mapSessionEvent(event);
    for (const update of updates) {
      this.sink.sendUpdate(String(session.id), update);
    }
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
