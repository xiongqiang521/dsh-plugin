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
import { JSONRPC, ErrorCode, } from "./types.js";
/** Raised when the remote peer answers a request with a JSON-RPC error. */
export class RemoteRpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.name = "RemoteRpcError";
        this.code = code;
        this.data = data;
    }
}
/**
 * Raised by a local request handler to answer with a specific JSON-RPC error
 * code (e.g. -32602 InvalidParams for a bad modeId) instead of the generic
 * -32603 InternalError the transport otherwise uses for thrown handlers.
 */
export class RpcRequestError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "RpcRequestError";
        this.code = code;
    }
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
export class StdioRpc {
    input;
    output;
    requestTimeoutMs;
    buffer = "";
    nextId = 1;
    closed = false;
    pending = new Map();
    requestHandlers = new Map();
    notificationHandlers = new Set();
    closeHandlers = new Set();
    errorHandlers = new Set();
    constructor(options) {
        this.input = options.input;
        this.output = options.output;
        this.requestTimeoutMs = options.requestTimeoutMs;
        this.input.on("data", (chunk) => {
            this.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        });
        this.input.on("end", () => this.handleClose());
        this.input.on("close", () => this.handleClose());
        this.input.on("error", (error) => {
            for (const handler of this.errorHandlers)
                handler(error);
            this.handleClose();
        });
    }
    // -------------------------------------------------------------------------
    // Inbound: frame, parse, classify
    // -------------------------------------------------------------------------
    feed(chunk) {
        if (this.closed)
            return;
        this.buffer += chunk;
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (line.trim() !== "")
                this.handleLine(line);
            newline = this.buffer.indexOf("\n");
        }
    }
    handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            this.sendError(null, ErrorCode.ParseError, "parse error");
            return;
        }
        if (typeof message !== "object" || message === null) {
            this.sendError(null, ErrorCode.InvalidRequest, "invalid request");
            return;
        }
        const record = message;
        if (record.jsonrpc !== JSONRPC) {
            if (typeof record.id !== "undefined") {
                this.sendError(record.id, ErrorCode.InvalidRequest, "invalid jsonrpc version");
            }
            return;
        }
        // A response to one of our requests (no method, carries result/error).
        if (typeof record.method === "undefined" && ("result" in record || "error" in record)) {
            this.handleResponse(record);
            return;
        }
        if (typeof record.method !== "string") {
            if (typeof record.id !== "undefined") {
                this.sendError(record.id, ErrorCode.InvalidRequest, "missing method");
            }
            return;
        }
        if (typeof record.id === "undefined") {
            this.dispatchNotification(record);
        }
        else {
            void this.dispatchRequest(record);
        }
    }
    async dispatchRequest(request) {
        const handler = this.requestHandlers.get(request.method);
        if (!handler) {
            this.sendError(request.id, ErrorCode.MethodNotFound, "method not found: " + request.method);
            return;
        }
        try {
            const result = await handler(request.params);
            this.send({ jsonrpc: JSONRPC, id: request.id, result: result === undefined ? null : result });
        }
        catch (error) {
            const code = error instanceof RpcRequestError ? error.code : ErrorCode.InternalError;
            const normalized = error instanceof Error ? error.message : String(error);
            this.sendError(request.id, code, normalized);
        }
    }
    dispatchNotification(notification) {
        for (const handler of this.notificationHandlers) {
            try {
                handler(notification.method, notification.params);
            }
            catch (error) {
                this.emitError(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
    handleResponse(record) {
        const id = record.id;
        if (typeof id === "undefined")
            return;
        const key = String(id);
        const entry = this.pending.get(key);
        if (!entry)
            return; // stale or unknown response — ignore
        this.pending.delete(key);
        if (entry.timer)
            clearTimeout(entry.timer);
        if ("error" in record && record.error != null) {
            const err = record.error;
            entry.reject(new RemoteRpcError(err.code ?? ErrorCode.InternalError, err.message ?? "remote error", err.data));
        }
        else {
            entry.resolve(record.result);
        }
    }
    // -------------------------------------------------------------------------
    // Outbound
    // -------------------------------------------------------------------------
    /** Send a request to the remote peer and resolve its result. */
    request(method, params) {
        if (this.closed)
            return Promise.reject(new Error("transport closed"));
        const id = "a" + this.nextId++;
        const key = String(id);
        return new Promise((resolve, reject) => {
            const entry = {
                resolve: resolve,
                reject,
            };
            if (this.requestTimeoutMs) {
                entry.timer = setTimeout(() => {
                    if (this.pending.delete(key)) {
                        reject(new Error("request timed out: " + method));
                    }
                }, this.requestTimeoutMs);
            }
            this.pending.set(key, entry);
            this.send({ jsonrpc: JSONRPC, id, method, params: params === undefined ? undefined : params });
        });
    }
    /** Send a one-way notification to the remote peer. */
    notify(method, params) {
        this.send({ jsonrpc: JSONRPC, method, params: params === undefined ? undefined : params });
    }
    /** Respond to an inbound request. */
    sendResult(id, result) {
        this.send({ jsonrpc: JSONRPC, id, result: result === undefined ? null : result });
    }
    /** Respond to an inbound request with an error. */
    sendError(id, code, message, data) {
        this.send({ jsonrpc: JSONRPC, id, error: { code, message, data } });
    }
    send(message) {
        if (this.closed)
            return;
        this.output.write(JSON.stringify(message) + "\n");
    }
    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------
    /** Register a handler for an inbound request method. */
    onRequest(method, handler) {
        this.requestHandlers.set(method, handler);
    }
    /** Register a handler for all inbound notifications. Returns a disposer. */
    onNotification(handler) {
        this.notificationHandlers.add(handler);
        return () => this.notificationHandlers.delete(handler);
    }
    onClose(handler) {
        this.closeHandlers.add(handler);
        return () => this.closeHandlers.delete(handler);
    }
    onError(handler) {
        this.errorHandlers.add(handler);
        return () => this.errorHandlers.delete(handler);
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    emitError(error) {
        for (const handler of this.errorHandlers)
            handler(error);
    }
    handleClose() {
        if (this.closed)
            return;
        this.closed = true;
        for (const [, entry] of this.pending) {
            if (entry.timer)
                clearTimeout(entry.timer);
            entry.reject(new Error("transport closed"));
        }
        this.pending.clear();
        for (const handler of this.closeHandlers)
            handler();
    }
    /** Whether the peer has closed (stdin ended or close() was called). */
    get isClosed() {
        return this.closed;
    }
    /** Explicitly tear the peer down. */
    close() {
        this.handleClose();
    }
}
//# sourceMappingURL=transport.js.map