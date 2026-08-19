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
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import {
  ClientMethod,
  AgentNotificationMethod,
  AgentRequestMethod,
  type AgentCapabilities,
  type Implementation,
  type InitializeParams,
  type InitializeResult,
  type ReadTextFileParams,
  type ReadTextFileResult,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionSetConfigOptionParams,
  type SessionSetConfigOptionResult,
  type SessionSetModeParams,
  type SessionSetModelParams,
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
import type { DshAgentBridge } from "../bridge/dsh-agent-bridge.js";
import type { UpdateSink } from "./session-update-pump.js";

/** Advertised agent capabilities: local tools, no session resume, text-only. */
const AGENT_CAPABILITIES: AgentCapabilities = {
  loadSession: false,
  promptCapabilities: {
    image: false,
    embeddedContext: false,
  },
};

const PROTOCOL_VERSION = 1;

/** Agent identity reported on initialize (name/title/version). */
function readAgentInfo(): Implementation {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { name?: string; version?: string };
    return {
      name: pkg.name ?? "@deepseek-ai/dsh-acp4idea",
      title: "dsh ACP adapter",
      version: pkg.version ?? "0.0.0",
    };
  } catch {
    return { name: "@deepseek-ai/dsh-acp4idea", title: "dsh ACP adapter", version: "0.0.0" };
  }
}

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

    // Execution mode (dsh agent presets) and model selection are real: a
    // client that probes them gets working handlers, not silent no-ops.
    this.transport.onRequest(ClientMethod.SessionSetMode, (params) =>
      this.track(this.handleSessionSetMode(params as SessionSetModeParams)));
    this.transport.onRequest(ClientMethod.SessionSetConfigOption, (params) =>
      this.track(this.handleSessionSetConfigOption(params as SessionSetConfigOptionParams)));
    this.transport.onRequest(ClientMethod.SessionSetModel, (params) =>
      this.track(this.handleSessionSetModel(params as SessionSetModelParams)));

    this.transport.onNotification((method, params) => this.handleNotification(method, params));
  }

  private handleInitialize(params: InitializeParams): InitializeResult {
    // Advertise the requested version when we support it, otherwise our own —
    // the client disconnects if it cannot match the negotiated version.
    const requested = params.protocolVersion;
    return {
      protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
      agentCapabilities: AGENT_CAPABILITIES,
      authMethods: [],
      agentInfo: readAgentInfo(),
    };
  }

  private async handleSessionNew(params: SessionNewParams): Promise<SessionNewResult> {
    if (!isAbsolute(params.cwd)) {
      throw new Error("cwd must be an absolute path: " + params.cwd);
    }
    const sessionId = await this.bridge.createSession(params.cwd);
    // Advertise modes + config options; failures are contained by the bridge,
    // so the session itself still works even when enumeration is sparse.
    const { modes, configOptions } = await this.bridge.getSessionConfig(sessionId);
    return { sessionId, modes, configOptions };
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

  private async handleSessionSetMode(params: SessionSetModeParams): Promise<Record<string, never>> {
    await this.bridge.setMode(params.sessionId, params.modeId);
    return {};
  }

  private async handleSessionSetConfigOption(
    params: SessionSetConfigOptionParams,
  ): Promise<SessionSetConfigOptionResult> {
    const configOptions = await this.bridge.setConfigOption(
      params.sessionId,
      params.configId,
      params.value,
    );
    return { configOptions };
  }

  private async handleSessionSetModel(params: SessionSetModelParams): Promise<Record<string, never>> {
    await this.bridge.setModel(params.sessionId, params.modelId);
    return {};
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === ClientMethod.SessionCancel) {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
      if (sessionId) this.bridge.cancel(sessionId);
    }
  }
}
