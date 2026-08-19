/**
 * ACP v1 agent server: session lifecycle + capability negotiation over the
 * stdio transport, delegating actual agent work to a DshAgentBridge.
 *
 * The server implements the client-facing methods (initialize, session/*) and
 * forwards every durable agent event to the client as a session/update
 * notification. It also exposes the agent -> client request surface
 * (fs/read_text_file, fs/write_text_file, terminal/*) as typed helpers, so a
 * future tool-interception layer can delegate file/terminal work to the IDE.
 *
 * @module acp4idea/acp/server
 */
import {
  ClientMethod,
  AgentNotificationMethod,
  AgentRequestMethod,
  type AgentCapabilities,
  type InitializeParams,
  type InitializeResult,
  type ReadTextFileParams,
  type ReadTextFileResult,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionStopParams,
  type SessionUpdate,
  type TerminalCreateParams,
  type TerminalCreateResult,
  type TerminalWaitForExitParams,
  type TerminalWaitForExitResult,
  type TerminalKillParams,
  type WriteTextFileParams,
  type WriteTextFileResult,
  type PromptContentBlock,
} from "./types.js";
import { StdioRpc } from "./transport.js";
import type { DshAgentBridge, UpdateSink } from "../bridge/dsh-agent-bridge.js";

/** Advertised agent capabilities: local tools, no session resume, text-only. */
const AGENT_CAPABILITIES: AgentCapabilities = {
  loadSession: false,
  promptCapabilities: {
    image: false,
    embeddedContext: false,
  },
};

const PROTOCOL_VERSION = 1;

/** Flatten ACP prompt content blocks into one plain-text prompt. */
function promptToText(blocks: PromptContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource":
        parts.push(block.resource.text);
        break;
      case "resource_link":
        parts.push("[resource: " + (block.name ?? block.uri) + "]");
        break;
      case "image":
        // Images are dropped for v1: dsh image input requires the attachment
        // service, which a headless ACP profile does not compose.
        parts.push("[image omitted]");
        break;
    }
  }
  return parts.join("\n").trim();
}

export class AcpServer implements UpdateSink {
  private readonly transport: StdioRpc;
  private readonly bridge: DshAgentBridge;
  private readonly active = new Set<Promise<unknown>>();

  constructor(transport: StdioRpc, bridge: DshAgentBridge) {
    this.transport = transport;
    this.bridge = bridge;
    bridge.setSink(this);
    this.registerHandlers();
  }

  /** Register an in-flight handler so drain() can wait for it. */
  private track<T>(task: Promise<T>): Promise<T> {
    this.active.add(task);
    void task
      .then(() => this.active.delete(task), () => this.active.delete(task));
    return task;
  }

  /**
   * Wait for every in-flight client request to settle. Used on transport close
   * (stdin EOF) so a slow request such as session/new (agent creation) is not
   * torn down mid-flight before the process exits.
   */
  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }

  /** UpdateSink: stream one agent update to the client. */
  sendUpdate(sessionId: string, update: SessionUpdate): void {
    this.transport.notify(AgentNotificationMethod.SessionUpdate, { sessionId, update });
  }

  // -------------------------------------------------------------------------
  // Agent -> client request helpers (available for future fs/terminal delegation)
  // -------------------------------------------------------------------------

  readTextFile(params: ReadTextFileParams): Promise<ReadTextFileResult> {
    return this.transport.request<ReadTextFileResult>(AgentRequestMethod.ReadTextFile, params);
  }

  writeTextFile(params: WriteTextFileParams): Promise<WriteTextFileResult> {
    return this.transport.request<WriteTextFileResult>(AgentRequestMethod.WriteTextFile, params);
  }

  terminalCreate(params: TerminalCreateParams): Promise<TerminalCreateResult> {
    return this.transport.request<TerminalCreateResult>(AgentRequestMethod.TerminalCreate, params);
  }

  terminalWaitForExit(params: TerminalWaitForExitParams): Promise<TerminalWaitForExitResult> {
    return this.transport.request<TerminalWaitForExitResult>(AgentRequestMethod.TerminalWaitForExit, params);
  }

  terminalKill(params: TerminalKillParams): Promise<unknown> {
    return this.transport.request(AgentRequestMethod.TerminalKill, params);
  }

  // -------------------------------------------------------------------------
  // Client -> agent handlers
  // -------------------------------------------------------------------------

  private registerHandlers(): void {
    this.transport.onRequest(ClientMethod.Initialize, (params) => this.handleInitialize(params as InitializeParams));
    this.transport.onRequest(ClientMethod.Authenticate, () => ({}));
    this.transport.onRequest(ClientMethod.SessionNew, (params) =>
      this.track(this.handleSessionNew(params as SessionNewParams)));
    this.transport.onRequest(ClientMethod.SessionPrompt, (params) =>
      this.track(this.handleSessionPrompt(params as SessionPromptParams)));
    this.transport.onRequest(ClientMethod.SessionStop, (params) =>
      this.track(this.handleSessionStop(params as SessionStopParams)));

    // No-op mode/model switches: this server exposes neither, so accept and
    // ignore rather than fail a client that probes them unconditionally.
    this.transport.onRequest(ClientMethod.SessionSetMode, () => ({}));
    this.transport.onRequest(ClientMethod.SessionSetModel, () => ({}));

    this.transport.onNotification((method, params) => this.handleNotification(method, params));
  }

  private handleInitialize(params: InitializeParams): InitializeResult {
    // Advertise our version; a client that cannot match it aborts the handshake.
    void params;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: AGENT_CAPABILITIES,
      authMethods: [],
    };
  }

  private async handleSessionNew(params: SessionNewParams): Promise<SessionNewResult> {
    const sessionId = await this.bridge.createSession(params.cwd);
    return { sessionId };
  }

  private async handleSessionPrompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const text = promptToText(params.prompt ?? []);
    const stopReason = await this.bridge.prompt(params.sessionId, text);
    return { stopReason };
  }

  private async handleSessionStop(params: SessionStopParams): Promise<Record<string, never>> {
    await this.bridge.stop(params.sessionId);
    return {};
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === ClientMethod.SessionCancel) {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
      if (sessionId) this.bridge.cancel(sessionId);
    }
  }
}
