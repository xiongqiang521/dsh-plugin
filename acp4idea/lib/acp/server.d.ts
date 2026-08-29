import { type ReadTextFileParams, type ReadTextFileResult, type SessionUpdate, type TerminalCreateParams, type TerminalCreateResult, type TerminalWaitForExitParams, type TerminalWaitForExitResult, type TerminalKillParams, type WriteTextFileParams, type WriteTextFileResult, type RequestPermissionParams, type RequestPermissionResult } from "./types.js";
import { type StdioRpc } from "./transport.js";
import type { DshAgentBridge } from "../bridge/dsh-agent-bridge.js";
import type { UpdateSink } from "./session-update-pump.js";
export declare class AcpServer implements UpdateSink {
    private readonly transport;
    private readonly bridge;
    private readonly active;
    constructor(transport: StdioRpc, bridge: DshAgentBridge);
    /** Register an in-flight handler so drain() can wait for it. */
    private track;
    /**
     * Wait for every in-flight client request to settle. Used on transport close
     * (stdin EOF) so a slow request such as session/new (agent creation) is not
     * torn down mid-flight before the process exits.
     */
    drain(): Promise<void>;
    /** UpdateSink: stream one agent update to the client. */
    sendUpdate(sessionId: string, update: SessionUpdate): void;
    readTextFile(params: ReadTextFileParams): Promise<ReadTextFileResult>;
    writeTextFile(params: WriteTextFileParams): Promise<WriteTextFileResult>;
    terminalCreate(params: TerminalCreateParams): Promise<TerminalCreateResult>;
    terminalWaitForExit(params: TerminalWaitForExitParams): Promise<TerminalWaitForExitResult>;
    terminalKill(params: TerminalKillParams): Promise<unknown>;
    /**
     * Ask the client for a one-shot permission decision (ACP
     * session/request_permission). The bridge's approval answerer uses this to
     * surface dsh approval asks in the IDE.
     */
    requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult>;
    private registerHandlers;
    private handleInitialize;
    private handleSessionNew;
    private handleSessionPrompt;
    private handleSessionStop;
    private handleSessionSetMode;
    private handleSessionSetConfigOption;
    private handleSessionSetModel;
    private handleNotification;
}
//# sourceMappingURL=server.d.ts.map