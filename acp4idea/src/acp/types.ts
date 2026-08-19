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
 *                    terminal/wait_for_exit, terminal/kill
 *     notifications: session/update, fs/update, terminal/output,
 *                    terminal/release
 *
 * The canonical machine-readable schema lives in the
 * 'agentclientprotocol/agent-client-protocol' repository; this module pins the
 * subset an ACP v1 agent server implements. Field and enum names follow the
 * published spec so a client-side validator can check messages against it.
 *
 * @module acp4idea/acp/types
 */

/** JSON-RPC 2.0 protocol version tag. */
export const JSONRPC = "2.0" as const;

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

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

export const ErrorCode = {
  /** -32700 — invalid JSON was received. */
  ParseError: -32700,
  /** -32600 — the JSON-RPC message is not a valid request/notification. */
  InvalidRequest: -32600,
  /** -32601 — the method does not exist or is not available. */
  MethodNotFound: -32601,
  /** -32602 — invalid method parameter(s). */
  InvalidParams: -32602,
  /** -32603 — internal error. */
  InternalError: -32603,
  /** -32800 — ACP: the request timed out. */
  RequestTimeout: -32800,
  /** -32801 — ACP: the request was cancelled. */
  RequestCancelled: -32801,
  /** -32802 — ACP: authentication is required before this method. */
  AuthRequired: -32802,
} as const;

/** Build a JSON-RPC error payload. */
export function rpcError(code: number, message: string, data?: unknown) {
  return { code, message, data };
}

// ---------------------------------------------------------------------------
// Capability negotiation (initialize)
// ---------------------------------------------------------------------------

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
}

/** 'authenticate' request params (client -> agent). */
export interface AuthenticateParams {
  methodId: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

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
}

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

/** 'session/set_model' request params (client -> agent). */
export interface SessionSetModelParams {
  sessionId: string;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Prompt content (client -> agent)
// ---------------------------------------------------------------------------

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
export type PromptContentBlock =
  | PromptTextBlock
  | PromptImageBlock
  | PromptResourceLinkBlock
  | PromptResourceBlock;

/** 'session/prompt' request params (client -> agent). */
export interface SessionPromptParams {
  sessionId: string;
  prompt: PromptContentBlock[];
}

/** Why the agent stopped a prompt turn. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | "user_tool_permission_denied"
  | "tool_permission_denied";

/** 'session/prompt' result. */
export interface SessionPromptResult {
  stopReason: StopReason;
}

// ---------------------------------------------------------------------------
// Session updates (agent -> client notifications)
// ---------------------------------------------------------------------------

/** A content block the agent streams back to the client. */
export interface AgentTextBlock {
  type: "text";
  text: string;
}

/** A thinking/reasoning block the agent streams back to the client. */
export interface AgentThinkingBlock {
  type: "thinking";
  text: string;
}

/** Content an agent streams in message/thought updates. */
export type AgentContentBlock = AgentTextBlock | AgentThinkingBlock;

/** Status of one tool call as reported to the client. */
export type ToolCallStatus =
  | { value: "in_progress" }
  | { value: "completed" }
  | { value: "failed"; error: string };

/** A tool call surfaced to the client. */
export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  /** Coarse classification; editors use it for icon/grouping. */
  kind: "use" | "edit" | "fetch" | "custom";
  status: ToolCallStatus;
  /** Human-readable summary (arguments or result), when available. */
  content?: string;
  /** Optional file locations the call touches. */
  locations?: { path: string }[];
}

/** A change to a previously surfaced tool call. */
export interface ToolCallStatusUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status: ToolCallStatus;
  content?: string;
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

/** The list of available commands changed. */
export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  commands: AvailableCommand[];
}

/** The active session mode changed. */
export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  sessionMode: string;
}

/** The active model changed. */
export interface CurrentModelUpdate {
  sessionUpdate: "current_model_update";
  modelId: string;
}

/** A client permission-state change the agent notifies the client about. */
export interface ClientPermissionsUpdate {
  sessionUpdate: "client_permissions_update";
  permissions: unknown;
}

/** Discriminated union of session updates. */
export type SessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | PlanUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | CurrentModelUpdate
  | ClientPermissionsUpdate;

/** 'session/update' notification params (agent -> client). */
export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

// ---------------------------------------------------------------------------
// File-system delegation (agent -> client requests)
// ---------------------------------------------------------------------------

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
  update:
    | { type: "text"; text: string }
    | { type: "diff"; diff: string }
    | { type: "create"; path: string }
    | { type: "delete"; path: string };
}

// ---------------------------------------------------------------------------
// Terminal delegation (agent -> client requests)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Method-name constants (kept in one place so dispatch stays greppable)
// ---------------------------------------------------------------------------

/** Client -> agent request/notification method names. */
export const ClientMethod = {
  Initialize: "initialize",
  Authenticate: "authenticate",
  SessionNew: "session/new",
  SessionLoad: "session/load",
  SessionPrompt: "session/prompt",
  SessionStop: "session/stop",
  SessionCancel: "session/cancel",
  SessionSetMode: "session/set_mode",
  SessionSetModel: "session/set_model",
} as const;

/** Agent -> client request method names. */
export const AgentRequestMethod = {
  ReadTextFile: "fs/read_text_file",
  WriteTextFile: "fs/write_text_file",
  TerminalCreate: "terminal/create",
  TerminalWaitForExit: "terminal/wait_for_exit",
  TerminalKill: "terminal/kill",
} as const;

/** Agent -> client notification method names. */
export const AgentNotificationMethod = {
  SessionUpdate: "session/update",
  FsUpdate: "fs/update",
  TerminalOutput: "terminal/output",
  TerminalRelease: "terminal/release",
} as const;
