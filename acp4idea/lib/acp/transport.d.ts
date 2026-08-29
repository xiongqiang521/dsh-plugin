/**
 * JSON-RPC 2.0 over stdio (newline-delimited JSON) transport.
 *
 * ACP frames each message as a single line of JSON on stdin/stdout. This peer
 * reads lines from stdin, dispatches requests/notifications/responses, and
 * writes JSON lines to stdout. Logging goes to stderr and never touches the
 * protocol stream.
 *
 * @module acp4idea/acp/transport
 */
import { type JsonRpcInbound } from "./types.js";
/** Raised when the remote peer answers a request with a JSON-RPC error. */
export declare class RemoteRpcError extends Error {
    readonly code: number;
    readonly data: unknown;
    constructor(code: number, message: string, data?: unknown);
}
/**
 * Raised by a local request handler to answer with a specific JSON-RPC error
 * code (e.g. -32602 InvalidParams for a bad modeId) instead of the generic
 * -32603 InternalError the transport otherwise uses for thrown handlers.
 */
export declare class RpcRequestError extends Error {
    readonly code: number;
    constructor(code: number, message: string);
}
type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void;
type CloseHandler = () => void;
type ErrorHandler = (error: Error) => void;
/**
 * Minimal structural view of the stdin/stdout pipes the peer owns. Kept free of
 * the full Node stream hierarchy so process.stdin/process.stdout satisfy it
 * without cast gymnastics.
 */
export interface TransportInput {
    on(event: "data", listener: (chunk: string | Buffer) => void): void;
    on(event: "end" | "close", listener: () => void): void;
    on(event: "error", listener: (error: Error) => void): void;
}
export interface TransportOutput {
    write(chunk: string): unknown;
}
/** Structural view of the stdio pipes the peer owns. */
export interface TransportOptions {
    input: TransportInput;
    output: TransportOutput;
    /** Optional per-request timeout in milliseconds (default: none). */
    requestTimeoutMs?: number;
}
/**
 * A bidirectional JSON-RPC peer bound to stdin/stdout.
 *
 * Inbound messages are classified by shape: a message carrying a 'method' is a
 * request (with 'id') or notification (without); a message without 'method'
 * carrying 'result'/'error' is a response to an outbound request. This keeps
 * the inbound-request id space (client-chosen) and outbound-request id space
 * (agent-chosen, string-prefixed) disjoint.
 */
export declare class StdioRpc {
    private readonly input;
    private readonly output;
    private readonly requestTimeoutMs?;
    private buffer;
    private nextId;
    private closed;
    private readonly pending;
    private readonly requestHandlers;
    private readonly notificationHandlers;
    private readonly closeHandlers;
    private readonly errorHandlers;
    constructor(options: TransportOptions);
    private feed;
    private handleLine;
    private dispatchRequest;
    private dispatchNotification;
    private handleResponse;
    /** Send a request to the remote peer and resolve its result. */
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    /** Send a one-way notification to the remote peer. */
    notify(method: string, params?: unknown): void;
    /** Respond to an inbound request. */
    sendResult(id: number | string, result: unknown): void;
    /** Respond to an inbound request with an error. */
    sendError(id: number | string | null, code: number, message: string, data?: unknown): void;
    private send;
    /** Register a handler for an inbound request method. */
    onRequest(method: string, handler: RequestHandler): void;
    /** Register a handler for all inbound notifications. Returns a disposer. */
    onNotification(handler: NotificationHandler): () => void;
    onClose(handler: CloseHandler): () => void;
    onError(handler: ErrorHandler): () => void;
    private emitError;
    private handleClose;
    /** Whether the peer has closed (stdin ended or close() was called). */
    get isClosed(): boolean;
    /** Explicitly tear the peer down. */
    close(): void;
}
/** Re-exported for callers that want a typed inbound message. */
export type { JsonRpcInbound };
//# sourceMappingURL=transport.d.ts.map