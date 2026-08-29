/**
 * acp4idea — an Agent Client Protocol (ACP) v1 server bundle for dsh.
 *
 * The Cordis plugin that a dedicated 'acp' profile mounts (see
 * cordis.patch.yml). On load it opens a long-lived JSON-RPC stdio transport,
 * wraps it in the ACP server, and bridges every ACP session to a dsh Agent
 * created through the core registry — the same factory dsh-headless uses, but
 * interactive and streamed.
 *
 * @module @xiongqiang521/dsh-acp4idea
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
/** Stable Cordis plugin name. */
export declare const name = "acp4idea";
/** Core services required before the stdio server can start. */
export declare const inject: string[];
/**
 * Plugin config. agentPreset is optional (no .required()).
 *
 * - sessionUpdateMode: "coalesced" (default) batches streamed message/thought
 *   deltas before sending ACP notifications; "legacy" sends every delta as its
 *   own notification (diagnostic / A/B baseline).
 * - contextWindow: context-window size (tokens) advertised in ACP usage_update.
 */
export declare const Config: z<Schemastery.ObjectS<{
    agentPreset: z<string, string>;
    sessionUpdateMode: z<string, string>;
    contextWindow: z<number, number>;
}>, Schemastery.ObjectT<{
    agentPreset: z<string, string>;
    sessionUpdateMode: z<string, string>;
    contextWindow: z<number, number>;
}>>;
/** The config shape apply reads (optional fields may be absent at runtime). */
export interface Acp4IdeaConfig {
    agentPreset?: string;
    sessionUpdateMode?: string;
    contextWindow?: number;
}
/**
 * Mount the ACP stdio server and keep it alive until stdin closes.
 *
 * @param ctx - plugin context carrying the Agent registry, default model, and
 *   the launcher-provided exit request.
 * @param config - validated config.
 */
export declare function apply(ctx: Context, config: Acp4IdeaConfig): void;
//# sourceMappingURL=index.d.ts.map