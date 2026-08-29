/**
 * Agent Client Protocol (ACP) v1 wire types.
 *
 * ACP is JSON-RPC 2.0 over stdio, newline-delimited (one JSON object per line).
 * Two peers exchange requests/notifications in both directions:
 *
 *   client (IntelliJ IDEA / Zed / ...)  ->  agent (this process):
 *     initialize, authenticate, session/new, session/load, session/prompt,
 *     session/stop, session/cancel (notification), session/set_mode,
 *     session/set_model
 *
 *   agent (this process)              ->  client:
 *     requests:      fs/read_text_file, fs/write_text_file, terminal/create,
 *                    terminal/wait_for_exit, terminal/kill,
 *                    session/request_permission
 *     notifications: session/update, fs/update, terminal/output,
 *                    terminal/release
 *
 * The canonical machine-readable schema lives in the
 * 'agentclientprotocol/agent-client-protocol' repository (published as
 * @agentclientprotocol/sdk); this module pins the subset an ACP v1 agent
 * server implements. Field and enum names follow the published spec so a
 * client-side validator can check messages against it — in particular the
 * plain-string `ToolCallStatus`, the fixed `ToolKind` vocabulary, and the
 * `content: ToolCallContent[]` shape of tool updates.
 *
 * @module acp4idea/acp/types
 */
/** JSON-RPC 2.0 protocol version tag. */
export declare const JSONRPC: "2.0";
/** A JSON-RPC 2.0 request (has an id, expects a response). */
export interface JsonRpcRequest {
    jsonrpc: typeof JSONRPC;
    id: number | string;
    method: string;
    params?: unknown;
}
/** A JSON-RPC 2.0 notification (no id, no response). */
export interface JsonRpcNotification {
    jsonrpc: typeof JSONRPC;
    method: string;
    params?: unknown;
}
/** A JSON-RPC 2.0 success response. */
export interface JsonRpcSuccess {
    jsonrpc: typeof JSONRPC;
    id: number | string;
    result: unknown;
}
/** A JSON-RPC 2.0 error response. */
export interface JsonRpcError {
    jsonrpc: typeof JSONRPC;
    id: number | string | null;
    error: {
        code: number;
        message: string;
        data?: unknown;
    };
}
/** Any inbound JSON-RPC message (request or notification). */
export type JsonRpcInbound = JsonRpcRequest | JsonRpcNotification;
export declare const ErrorCode: {
    /** -32700 — invalid JSON was received. */
    readonly ParseError: -32700;
    /** -32600 — the JSON-RPC message is not a valid request/notification. */
    readonly InvalidRequest: -32600;
    /** -32601 — the method does not exist or is not available. */
    readonly MethodNotFound: -32601;
    /** -32602 — invalid method parameter(s). */
    readonly InvalidParams: -32602;
    /** -32603 — internal error. */
    readonly InternalError: -32603;
    /** -32800 — ACP: the request timed out. */
    readonly RequestTimeout: -32800;
    /** -32801 — ACP: the request was cancelled. */
    readonly RequestCancelled: -32801;
    /** -32802 — ACP: authentication is required before this method. */
    readonly AuthRequired: -32802;
};
/** Build a JSON-RPC error payload. */
export declare function rpcError(code: number, message: string, data?: unknown): {
    code: number;
    message: string;
    data: unknown;
};
/** Capabilities the client (IDE) advertises to the agent. */
export interface ClientCapabilities {
    /** File-system delegation the client can service on the agent's behalf. */
    fs?: {
        readTextFile?: boolean;
        writeTextFile?: boolean;
    };
    /** Terminal delegation the client can service on the agent's behalf. */
    terminal?: boolean;
    /** The client can load (resume) prior sessions. */
    loadSession?: boolean;
}
/** Capabilities the agent (this server) advertises to the client. */
export interface AgentCapabilities {
    /** The agent can resume prior sessions via session/load. */
    loadSession?: boolean;
    /** Prompt content the agent accepts beyond plain text. */
    promptCapabilities?: {
        image?: boolean;
        embeddedContext?: boolean;
    };
}
/** One authentication method the agent may require. */
export interface AuthMethod {
    id: string;
    name: string;
    description?: string;
    /** Opaque method-specific payload. */
    [key: string]: unknown;
}
/** Agent identity sent back on initialize (name/title/version). */
export interface Implementation {
    /** Programmatic name, also used as display fallback. */
    name: string;
    /** Human-readable display title. */
    title?: string;
    /** Version string (e.g. "0.2.0"). */
    version: string;
}
/** 'initialize' request params (client -> agent). */
export interface InitializeParams {
    protocolVersion: number;
    clientCapabilities: ClientCapabilities;
}
/** 'initialize' result (agent -> client). */
export interface InitializeResult {
    protocolVersion: number;
    agentCapabilities: AgentCapabilities;
    authMethods?: AuthMethod[];
    agentInfo?: Implementation;
}
/** 'authenticate' request params (client -> agent). */
export interface AuthenticateParams {
    methodId: string;
}
/** An MCP server the client asks the agent to connect (accepted, not required). */
export interface McpServer {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}
/** 'session/new' request params (client -> agent). */
export interface SessionNewParams {
    cwd: string;
    mcpServers?: McpServer[];
}
/** 'session/new' result. */
export interface SessionNewResult {
    sessionId: string;
    /** Initial mode state, when the deployment exposes agent presets. */
    modes?: SessionModeState | null;
    /** Initial session configuration options (model / thought level). */
    configOptions?: SessionConfigOption[] | null;
}
/** A mode the agent can operate in (mapped to a dsh agent preset). */
export interface SessionMode {
    /** Stable identifier used to refer to this mode in later messages. */
    id: string;
    /** Human-readable name shown for this mode. */
    name: string;
    /** Optional human-readable details shown with this mode. */
    description?: string | null;
}
/** The set of modes and the one currently active. */
export interface SessionModeState {
    /** The current mode the agent is in. */
    currentModeId: string;
    /** The set of modes the agent can operate in. */
    availableModes: SessionMode[];
}
/**
 * Semantic category for a session configuration option (UX only). Free-form
 * string on the wire; canonical values used by this server are "model" and
 * "thought_level".
 */
export type SessionConfigOptionCategory = string;
/** A possible value for a session configuration option. */
export interface SessionConfigSelectOption {
    value: string;
    name: string;
    description?: string | null;
}
/** A group of possible values for a session configuration option. */
export interface SessionConfigSelectGroup {
    group: string;
    name: string;
    options: SessionConfigSelectOption[];
}
/** Possible values for a session configuration option. */
export type SessionConfigSelectOptions = SessionConfigSelectOption[] | SessionConfigSelectGroup[];
/** A single-value selector (dropdown) session configuration option payload. */
export interface SessionConfigSelect {
    /** The currently selected value. */
    currentValue: string;
    /** The set of selectable options. */
    options: SessionConfigSelectOptions;
}
/** A boolean on/off toggle session configuration option payload. */
export interface SessionConfigBoolean {
    /** The current value of the boolean option. */
    currentValue: boolean;
}
/** A session configuration option selector and its current state. */
export type SessionConfigOption = {
    /** Unique identifier for the configuration option. */
    id: string;
    /** Human-readable label for the option. */
    name: string;
    /** Optional description for the client to display to the user. */
    description?: string | null;
    /** Optional semantic category for this option (UX only). */
    category?: SessionConfigOptionCategory | null;
} & (({
    type: "select";
} & SessionConfigSelect) | ({
    type: "boolean";
} & SessionConfigBoolean));
/** 'session/load' request params (client -> agent). */
export interface SessionLoadParams {
    sessionId: string;
    cwd: string;
    mcpServers?: McpServer[];
}
/** 'session/load' result. */
export interface SessionLoadResult {
    sessionId: string;
    modes: string[];
    currentMode: string;
}
/** 'session/stop' request params (client -> agent). */
export interface SessionStopParams {
    sessionId: string;
}
/** 'session/cancel' notification params (client -> agent). */
export interface SessionCancelParams {
    sessionId: string;
}
/** 'session/set_mode' request params (client -> agent). */
export interface SessionSetModeParams {
    sessionId: string;
    modeId: string;
}
/** 'session/set_mode' result. */
export type SessionSetModeResult = Record<string, never>;
/** 'session/set_config_option' request params (client -> agent). */
export interface SessionSetConfigOptionParams {
    sessionId: string;
    configId: string;
    /** Select value id, or boolean value for boolean options. */
    value: string | boolean;
    type?: "boolean";
}
/** 'session/set_config_option' result. */
export interface SessionSetConfigOptionResult {
    /** The full set of configuration options and their current values. */
    configOptions: SessionConfigOption[];
}
/** 'session/set_model' request params (client -> agent; legacy/UNSTABLE surface). */
export interface SessionSetModelParams {
    sessionId: string;
    modelId: string;
}
/** 'session/set_model' result. */
export type SessionSetModelResult = Record<string, never>;
/** A text block in a prompt. */
export interface PromptTextBlock {
    type: "text";
    text: string;
}
/** A base64-encoded image block in a prompt. */
export interface PromptImageBlock {
    type: "image";
    /** Base64-encoded image bytes. */
    data: string;
    mimeType: string;
}
/** A reference to a resource the client owns (e.g. an open editor buffer). */
export interface PromptResourceLinkBlock {
    type: "resource_link";
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
    size?: number;
}
/** An inline resource the client embeds. */
export interface PromptResourceBlock {
    type: "resource";
    resource: {
        uri: string;
        text: string;
        mimeType?: string;
    };
}
/** One content block in a 'session/prompt' call. */
export type PromptContentBlock = PromptTextBlock | PromptImageBlock | PromptResourceLinkBlock | PromptResourceBlock;
/** 'session/prompt' request params (client -> agent). */
export interface SessionPromptParams {
    sessionId: string;
    prompt: PromptContentBlock[];
}
/** Why the agent stopped a prompt turn. */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "user_tool_permission_denied" | "tool_permission_denied";
/** 'session/prompt' result. */
export interface SessionPromptResult {
    stopReason: StopReason;
}
/**
 * A text block the agent streams back to the client.
 *
 * Reasoning deltas reuse the same shape: ACP has no native 'thinking' content
 * block, so `agent_thought_chunk` carries plain text blocks too (the same
 * choice pi-acp makes; JetBrains' kotlinx.serialization rejects unknown
 * variants).
 */
export interface AgentTextBlock {
    type: "text";
    text: string;
}
/** Content an agent streams in message/thought updates (a SINGLE block per spec). */
export type AgentContentBlock = AgentTextBlock;
/**
 * Execution status of a tool call. A plain string per the canonical ACP schema
 * (NOT an object wrapper).
 */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
/**
 * Categories of tools that can be invoked — the canonical ACP vocabulary.
 * Clients use these to pick icons and grouping.
 */
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
/** Structured content produced by a tool call (canonical ACP shape). */
export type ToolCallContent = {
    type: "content";
    content: AgentContentBlock;
} | {
    type: "diff";
    path: string;
    oldText: string | null;
    newText: string;
} | {
    type: "terminal";
    terminalId: string;
    title?: string;
};
/** One file location a tool call touches. */
export interface ToolCallLocation {
    path: string;
    line?: number;
    lineCount?: number;
}
/** A tool call surfaced to the client (sessionUpdate: "tool_call"). */
export interface ToolCallUpdate {
    sessionUpdate: "tool_call";
    toolCallId: string;
    title: string;
    kind: ToolKind;
    status: ToolCallStatus;
    /** Raw (typically JSON) tool arguments, when available. */
    rawInput?: unknown;
    locations?: ToolCallLocation[];
    /** Structured content produced by the call, when available. */
    content?: ToolCallContent[];
    /** Opaque meta payload reserved for agent/client extensions. */
    _meta?: Record<string, unknown>;
}
/** A change to a previously surfaced tool call (sessionUpdate: "tool_call_update"). */
export interface ToolCallStatusUpdate {
    sessionUpdate: "tool_call_update";
    toolCallId: string;
    status?: ToolCallStatus;
    kind?: ToolKind;
    title?: string;
    content?: ToolCallContent[];
    rawInput?: unknown;
    rawOutput?: unknown;
    locations?: ToolCallLocation[];
    _meta?: Record<string, unknown>;
}
/** One entry in a plan/todo update. */
export interface PlanEntry {
    title: string;
    status: "todo" | "doing" | "done";
    priority: number;
    subTasks?: PlanEntry[];
}
/** A plan (todo list) snapshot surfaced to the client. */
export interface PlanUpdate {
    sessionUpdate: "plan";
    entries: PlanEntry[];
}
/** A streamed assistant message chunk (content is a SINGLE block per ACP spec). */
export interface AgentMessageChunkUpdate {
    sessionUpdate: "agent_message_chunk";
    content: AgentContentBlock;
}
/** A streamed thinking/reasoning chunk (content is a SINGLE block per ACP spec). */
export interface AgentThoughtChunkUpdate {
    sessionUpdate: "agent_thought_chunk";
    content: AgentContentBlock;
}
/** A command the client should expose to the user. */
export interface AvailableCommand {
    name: string;
    description: string;
    input?: unknown;
}
/** The list of available commands changed (canonical field: availableCommands). */
export interface AvailableCommandsUpdate {
    sessionUpdate: "available_commands_update";
    availableCommands: AvailableCommand[];
}
/** The active session mode changed (canonical field: currentModeId). */
export interface CurrentModeUpdate {
    sessionUpdate: "current_mode_update";
    currentModeId: string;
}
/** Session configuration options have been updated. */
export interface ConfigOptionUpdate {
    sessionUpdate: "config_option_update";
    /** The full set of configuration options and their current values. */
    configOptions: SessionConfigOption[];
}
/** A client permission-state change the agent notifies the client about. */
export interface ClientPermissionsUpdate {
    sessionUpdate: "client_permissions_update";
    permissions: unknown;
}
/** Update to session metadata (title / last-activity timestamp). */
export interface SessionInfoUpdate {
    sessionUpdate: "session_info_update";
    /** Human-readable session title; null clears it. */
    title?: string | null;
    /** ISO 8601 timestamp of last activity. */
    updatedAt?: string | null;
}
/** Cost information for a session. */
export interface Cost {
    /** Total cumulative cost, in `currency` units. */
    amount: number;
    /** ISO 4217 currency code (e.g. "USD"). */
    currency: string;
}
/** Context-window usage and cost update for a session. */
export interface UsageUpdate {
    sessionUpdate: "usage_update";
    /** Tokens currently in context. */
    used: number;
    /** Total context window size in tokens. */
    size: number;
    /** Cumulative session cost, when known. */
    cost?: Cost;
}
/** Discriminated union of session updates. */
export type SessionUpdate = AgentMessageChunkUpdate | AgentThoughtChunkUpdate | PlanUpdate | ToolCallUpdate | ToolCallStatusUpdate | AvailableCommandsUpdate | CurrentModeUpdate | ConfigOptionUpdate | ClientPermissionsUpdate | SessionInfoUpdate | UsageUpdate;
/** 'session/update' notification params (agent -> client). */
export interface SessionUpdateParams {
    sessionId: string;
    update: SessionUpdate;
}
/** 'fs/read_text_file' request params. */
export interface ReadTextFileParams {
    sessionId: string;
    path: string;
    /** 1-based first line to return. */
    line?: number;
    /** Maximum number of lines to return. */
    lineCount?: number;
}
/** 'fs/read_text_file' result. */
export interface ReadTextFileResult {
    content: string;
    lineCount: number;
    totalLines: number;
}
/** 'fs/write_text_file' request params. */
export interface WriteTextFileParams {
    sessionId: string;
    path: string;
    content: string;
}
/** 'fs/write_text_file' result. */
export interface WriteTextFileResult {
    /** Present when the write created a new file. */
    created?: boolean;
    /** Present when the client tracked the write as a diff. */
    diff?: unknown;
}
/** 'fs/update' notification params (streaming file edits back to the client). */
export interface FsUpdateParams {
    sessionId: string;
    update: {
        type: "text";
        text: string;
    } | {
        type: "diff";
        diff: string;
    } | {
        type: "create";
        path: string;
    } | {
        type: "delete";
        path: string;
    };
}
/** 'terminal/create' request params. */
export interface TerminalCreateParams {
    sessionId: string;
    cwd: string;
    command: string;
    args?: string[];
}
/** 'terminal/create' result. */
export interface TerminalCreateResult {
    terminalId: string;
}
/** 'terminal/output' notification params. */
export interface TerminalOutputParams {
    sessionId: string;
    terminalId: string;
    output: string;
}
/** 'terminal/wait_for_exit' request params. */
export interface TerminalWaitForExitParams {
    sessionId: string;
    terminalId: string;
}
/** 'terminal/wait_for_exit' result. */
export interface TerminalWaitForExitResult {
    exitCode: number;
}
/** 'terminal/kill' request params. */
export interface TerminalKillParams {
    sessionId: string;
    terminalId: string;
}
/** 'terminal/release' notification params. */
export interface TerminalReleaseParams {
    sessionId: string;
    terminalId: string;
}
/**
 * The nature of a permission option, as the canonical ACP vocabulary defines
 * it. dsh's approval seam is one-shot, so this server advertises only
 * `allow_once` / `reject_once` — never the always-variants, which would promise
 * remembered rules dsh does not have.
 */
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
/** One option the user may pick when a permission request is presented. */
export interface PermissionOption {
    /** Stable id the response echoes back (e.g. "allow_once"). */
    optionId: string;
    /** Human-readable label to display to the user. */
    name: string;
    /** Hint about the nature of this option (icon / UI treatment). */
    kind: PermissionOptionKind;
}
/** 'session/request_permission' request params (agent -> client). */
export interface RequestPermissionParams {
    sessionId: string;
    /**
     * The tool call the question attaches to — the same shape already streamed as
     * a `tool_call` session/update, so the client can bind the dialog to it.
     */
    toolCall: ToolCallUpdate;
    /** Options the client presents to the user. */
    options: PermissionOption[];
    /** Opaque extension payload (the asker's reason rides here; see permission.ts). */
    _meta?: Record<string, unknown>;
}
/** The user's decision on a permission request. */
export type RequestPermissionOutcome = {
    outcome: "cancelled";
} | {
    outcome: "selected";
    optionId: string;
};
/** 'session/request_permission' result (client -> agent). */
export interface RequestPermissionResult {
    outcome: RequestPermissionOutcome;
}
/** Client -> agent request/notification method names. */
export declare const ClientMethod: {
    readonly Initialize: "initialize";
    readonly Authenticate: "authenticate";
    readonly SessionNew: "session/new";
    readonly SessionLoad: "session/load";
    readonly SessionPrompt: "session/prompt";
    readonly SessionStop: "session/stop";
    readonly SessionCancel: "session/cancel";
    readonly SessionSetMode: "session/set_mode";
    readonly SessionSetConfigOption: "session/set_config_option";
    readonly SessionSetModel: "session/set_model";
};
/** Agent -> client request method names. */
export declare const AgentRequestMethod: {
    readonly ReadTextFile: "fs/read_text_file";
    readonly WriteTextFile: "fs/write_text_file";
    readonly TerminalCreate: "terminal/create";
    readonly TerminalWaitForExit: "terminal/wait_for_exit";
    readonly TerminalKill: "terminal/kill";
    readonly RequestPermission: "session/request_permission";
};
/** Agent -> client notification method names. */
export declare const AgentNotificationMethod: {
    readonly SessionUpdate: "session/update";
    readonly FsUpdate: "fs/update";
    readonly TerminalOutput: "terminal/output";
    readonly TerminalRelease: "terminal/release";
};
//# sourceMappingURL=types.d.ts.map