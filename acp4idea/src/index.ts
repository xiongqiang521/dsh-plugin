/**
 * acp4idea — an Agent Client Protocol (ACP) v1 server bundle for dsh.
 *
 * The Cordis plugin that a dedicated 'acp' profile mounts (see
 * cordis.patch.yml). On load it opens a long-lived JSON-RPC stdio transport,
 * wraps it in the ACP server, and bridges every ACP session to a dsh Agent
 * created through the core registry — the same factory dsh-headless uses, but
 * interactive and streamed.
 *
 * @module @deepseek-ai/dsh-acp4idea
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { StdioRpc } from "./acp/transport.js";
import { AcpServer } from "./acp/server.js";
import { DshAgentBridge } from "./bridge/dsh-agent-bridge.js";

/** Stable Cordis plugin name. */
export const name = "acp4idea";

/** Core services required before the stdio server can start. */
export const inject = ["agents", "agentDefaultModel", "sessions"];

/** Plugin config. agentPreset is optional (no .required()). */
export const Config = z.object({
  agentPreset: z.string(),
});

/** The config shape apply reads (agentPreset may be absent at runtime). */
export interface Acp4IdeaConfig {
  agentPreset?: string;
}

/**
 * Mount the ACP stdio server and keep it alive until stdin closes.
 *
 * @param ctx - plugin context carrying the Agent registry, default model, and
 *   the launcher-provided exit request.
 * @param config - validated config.
 */
export function apply(ctx: Context, config: Acp4IdeaConfig): void {
  const exit = ctx.get("appExit") as ((code: number) => void) | undefined;
  if (exit === undefined) {
    throw new Error("acp4idea: the launcher must provide ctx.appExit before the tree mounts");
  }

  const transport = new StdioRpc({
    input: process.stdin,
    output: process.stdout,
  });

  const bridge = new DshAgentBridge(ctx, {
    agentPreset: config.agentPreset || undefined,
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
      } catch {
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
