import z from "@deepseek-ai/schemastery";
import { StdioRpc } from "./acp/transport.js";
import { AcpServer } from "./acp/server.js";
import { parseSessionUpdateMode } from "./acp/session-update-pump.js";
import { DshAgentBridge } from "./bridge/dsh-agent-bridge.js";
/** Stable Cordis plugin name. */
export const name = "acp4idea";
/** Core services required before the stdio server can start. */
export const inject = ["agents", "agentDefaultModel", "sessions"];
/**
 * Plugin config. agentPreset is optional (no .required()).
 *
 * - sessionUpdateMode: "coalesced" (default) batches streamed message/thought
 *   deltas before sending ACP notifications; "legacy" sends every delta as its
 *   own notification (diagnostic / A/B baseline).
 * - contextWindow: context-window size (tokens) advertised in ACP usage_update.
 */
export const Config = z.object({
    agentPreset: z.string(),
    sessionUpdateMode: z.string(),
    contextWindow: z.number(),
});
/**
 * Mount the ACP stdio server and keep it alive until stdin closes.
 *
 * @param ctx - plugin context carrying the Agent registry, default model, and
 *   the launcher-provided exit request.
 * @param config - validated config.
 */
export function apply(ctx, config) {
    const exit = ctx.get("appExit");
    if (exit === undefined) {
        throw new Error("acp4idea: the launcher must provide ctx.appExit before the tree mounts");
    }
    const transport = new StdioRpc({
        input: process.stdin,
        output: process.stdout,
    });
    const bridge = new DshAgentBridge(ctx, {
        agentPreset: config.agentPreset || undefined,
        sessionUpdateMode: parseSessionUpdateMode(config.sessionUpdateMode || undefined),
        contextWindow: config.contextWindow,
    });
    // The server owns the transport and registers the client-facing methods.
    const server = new AcpServer(transport, bridge);
    transport.onError((error) => {
        process.stderr.write("acp4idea: " + error.message + "\n");
    });
    transport.onClose(() => {
        void (async () => {
            try {
                await server.drain();
            }
            catch {
                // drain is best-effort; still tear down and exit
            }
            bridge.dispose();
            exit(0);
        })();
    });
    // Tear every live agent down when this plugin fiber unloads (SIGINT/SIGTERM).
    ctx.effect(() => () => {
        bridge.dispose();
    });
}
//# sourceMappingURL=index.js.map