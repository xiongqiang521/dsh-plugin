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
import {
  JSONRPC,
  ErrorCode,
  type JsonRpcInbound,
  type JsonRpcRequest,
  type JsonRpcNotification,
} from "./types.js";

/** Raised when the remote peer answers a request with a JSON-RPC error. */
export class RemoteRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RemoteRpcError";
    this.code = code;
    this.data = data;
  }
}

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void;
type CloseHandler = () => void;
type ErrorHandler = (error: Error) => void;

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

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
export class StdioRpc {
  private readonly input: TransportInput;
  private readonly output: TransportOutput;
  private readonly requestTimeoutMs?: number;

  private buffer = "";
  private nextId = 1;
  private closed = false;

  private readonly pending = new Map<string, PendingEntry>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();

  constructor(options: TransportOptions) {
    this.input = options.input;
    this.output = options.output;
    this.requestTimeoutMs = options.requestTimeoutMs;

    this.input.on("data", (chunk) => {
      this.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    this.input.on("end", () => this.handleClose());
    this.input.on("close", () => this.handleClose());
    this.input.on("error", (error) => {
      for (const handler of this.errorHandlers) handler(error);
      this.handleClose();
    });
  }

  // -------------------------------------------------------------------------
  // Inbound: frame, parse, classify
  // -------------------------------------------------------------------------

  private feed(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== "") this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.sendError(null, ErrorCode.ParseError, "parse error");
      return;
    }
    if (typeof message !== "object" || message === null) {
      this.sendError(null, ErrorCode.InvalidRequest, "invalid request");
      return;
    }

    const record = message as Record<string, unknown>;
    if (record.jsonrpc !== JSONRPC) {
      if (typeof record.id !== "undefined") {
        this.sendError(record.id as number | string, ErrorCode.InvalidRequest, "invalid jsonrpc version");
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
        this.sendError(record.id as number | string, ErrorCode.InvalidRequest, "missing method");
      }
      return;
    }

    if (typeof record.id === "undefined") {
      this.dispatchNotification(record as unknown as JsonRpcNotification);
    } else {
      void this.dispatchRequest(record as unknown as JsonRpcRequest);
    }
  }

  private async dispatchRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(request.method);
    if (!handler) {
      this.sendError(request.id, ErrorCode.MethodNotFound, "method not found: " + request.method);
      return;
    }
    try {
      const result = await handler(request.params);
      this.send({ jsonrpc: JSONRPC, id: request.id, result: result === undefined ? null : result });
    } catch (error) {
      const normalized = error instanceof Error ? error.message : String(error);
      this.sendError(request.id, ErrorCode.InternalError, normalized);
    }
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification.method, notification.params);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleResponse(record: Record<string, unknown>): void {
    const id = record.id as string | number | undefined;
    if (typeof id === "undefined") return;
    const key = String(id);
    const entry = this.pending.get(key);
    if (!entry) return; // stale or unknown response — ignore
    this.pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if ("error" in record && record.error != null) {
      const err = record.error as { code?: number; message?: string; data?: unknown };
      entry.reject(new RemoteRpcError(err.code ?? ErrorCode.InternalError, err.message ?? "remote error", err.data));
    } else {
      entry.resolve(record.result);
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /** Send a request to the remote peer and resolve its result. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("transport closed"));
    const id = "a" + this.nextId++;
    const key = String(id);
    return new Promise<T>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve: resolve as (value: unknown) => void,
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
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: JSONRPC, method, params: params === undefined ? undefined : params });
  }

  /** Respond to an inbound request. */
  sendResult(id: number | string, result: unknown): void {
    this.send({ jsonrpc: JSONRPC, id, result: result === undefined ? null : result });
  }

  /** Respond to an inbound request with an error. */
  sendError(id: number | string | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: JSONRPC, id, error: { code, message, data } });
  }

  private send(message: unknown): void {
    if (this.closed) return;
    this.output.write(JSON.stringify(message) + "\n");
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /** Register a handler for an inbound request method. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Register a handler for all inbound notifications. Returns a disposer. */
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error("transport closed"));
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) handler();
  }

  /** Whether the peer has closed (stdin ended or close() was called). */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Explicitly tear the peer down. */
  close(): void {
    this.handleClose();
  }
}

/** Re-exported for callers that want a typed inbound message. */
export type { JsonRpcInbound };
