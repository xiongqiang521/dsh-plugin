import { classifyTool } from "../acp/tool-kind.js";
/** Join the text blocks of one content list into a single string. */
function extractText(blocks) {
    let out = "";
    for (const block of blocks) {
        if (block.type === "text")
            out += block.text;
    }
    return out;
}
/** Parse raw tool-arguments JSON, falling back to the raw string. */
function parseArguments(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
/** Pull a file path out of tool arguments for file-touching tools. */
function extractLocations(name, args) {
    if (typeof args !== "object" || args === null)
        return undefined;
    const record = args;
    const rawPath = record.file_path ?? record.path ?? record.filePath;
    if (typeof rawPath !== "string" || rawPath.length === 0)
        return undefined;
    // Only file-touching tools advertise locations.
    const kind = classifyTool(name);
    if (kind !== "edit" && kind !== "read" && kind !== "delete" && kind !== "move")
        return undefined;
    return [{ path: rawPath }];
}
function mapTodoStatus(status) {
    switch (status) {
        case "pending": return "todo";
        case "in_progress": return "doing";
        case "completed": return "done";
    }
}
/**
 * Map one durable session event to zero or more structured ops.
 *
 * - assistant/chunk    -> append-text / append-thought (stream deltas)
 * - assistant/message  -> assistant-message (assembled text + usage)
 * - tool/call          -> send tool_call (in_progress)
 * - tool/result        -> send tool_call_update (completed / failed)
 * - todo/write         -> send plan (whole-list snapshot)
 * - everything else    -> no op
 */
export function mapSessionEvent(event) {
    switch (event.type) {
        case "assistant/chunk": {
            const { turn, step, chunk } = event.data;
            if (chunk.type === "text-delta") {
                return chunk.text.length > 0 ? [{ op: "append-text", turn, step, text: chunk.text }] : [];
            }
            if (chunk.type === "reasoning-delta") {
                return chunk.text.length > 0 ? [{ op: "append-thought", turn, step, text: chunk.text }] : [];
            }
            // tool-call-delta / block-start / block-end / usage / finish: the bridge
            // learns the final tool call from the tool/call event; nothing to stream.
            return [];
        }
        case "assistant/message": {
            const { turn, step, message, usage } = event.data;
            const textParts = [];
            const thinkingParts = [];
            for (const block of message.content) {
                if (block.type === "text") {
                    textParts.push(block.text);
                }
                else if (block.type === "reasoning") {
                    thinkingParts.push(block.text);
                }
            }
            return [{
                    op: "assistant-message",
                    turn,
                    step,
                    textParts,
                    thinkingParts,
                    usage,
                }];
        }
        case "tool/call": {
            const { callId, name, arguments: rawArguments } = event.data;
            const parsed = parseArguments(rawArguments);
            const update = {
                sessionUpdate: "tool_call",
                toolCallId: String(callId),
                title: name,
                kind: classifyTool(name),
                status: "in_progress",
                rawInput: parsed,
            };
            const locations = extractLocations(name, parsed);
            if (locations)
                update.locations = locations;
            return [{ op: "send", update }];
        }
        case "tool/result": {
            const { message, error } = event.data;
            const resultBlock = message.content[0];
            const resultText = resultBlock ? extractText(resultBlock.content) : "";
            const failed = error != null || resultBlock?.isError === true;
            const callId = String(message.source.callId);
            const update = {
                sessionUpdate: "tool_call_update",
                toolCallId: callId,
                status: failed ? "failed" : "completed",
                // Canonical shape: structured content array (not a bare string).
                content: resultText.length > 0
                    ? [{ type: "content", content: { type: "text", text: resultText } }]
                    : undefined,
                rawOutput: resultText,
            };
            if (failed && error) {
                update.title = error.name + ": " + error.code;
            }
            return [{ op: "send", update }];
        }
        case "todo/write": {
            return [{
                    op: "send",
                    update: {
                        sessionUpdate: "plan",
                        entries: event.data.todos.map((item, index) => ({
                            title: item.content,
                            status: mapTodoStatus(item.status),
                            priority: index,
                            subTasks: [],
                        })),
                    },
                }];
        }
        default:
            return [];
    }
}
//# sourceMappingURL=event-map.js.map