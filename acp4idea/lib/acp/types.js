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
export const JSONRPC = "2.0";
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
};
/** Build a JSON-RPC error payload. */
export function rpcError(code, message, data) {
    return { code, message, data };
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
    SessionSetConfigOption: "session/set_config_option",
    SessionSetModel: "session/set_model",
};
/** Agent -> client request method names. */
export const AgentRequestMethod = {
    ReadTextFile: "fs/read_text_file",
    WriteTextFile: "fs/write_text_file",
    TerminalCreate: "terminal/create",
    TerminalWaitForExit: "terminal/wait_for_exit",
    TerminalKill: "terminal/kill",
    RequestPermission: "session/request_permission",
};
/** Agent -> client notification method names. */
export const AgentNotificationMethod = {
    SessionUpdate: "session/update",
    FsUpdate: "fs/update",
    TerminalOutput: "terminal/output",
    TerminalRelease: "terminal/release",
};
//# sourceMappingURL=types.js.map