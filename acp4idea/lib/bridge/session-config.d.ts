/**
 * Session configuration service: ACP modes, model selection, and thought level.
 *
 * ACP `session/new` advertises the deployment's agent-preset roster as modes
 * and the registered providers' models as config options; `session/set_mode`
 * and `session/set_config_option` mutate the session's mutable selection
 * (`ModelSelectionRef`), taking effect from the next model step. All catalog
 * reads fail soft — the session itself still works when enumeration is sparse.
 *
 * This is the enumeration/validation half of the bridge; it owns no transport
 * and no pump, so it stays unit-testable. The bridge delegates and performs the
 * pump notifications (current_mode_update / config_option_update).
 *
 * @module acp4idea/bridge/session-config
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import { type SessionConfigOption, type SessionModeState } from "../acp/types.js";
import type { PresetsService, SessionState } from "./types.js";
/** Config-option ids advertised in session/new (pi-acp uses the same pair). */
export declare const MODEL_CONFIG_ID = "model";
export declare const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
/**
 * Whether a session carries model-visible conversation content (seed and
 * lifecycle markers do not count — only actual prompts, model output, tool
 * work, or a closed turn do).
 */
export declare function hasProducedContent(session: Session): boolean;
export declare class SessionConfigService {
    private readonly ctx;
    constructor(ctx: Context);
    presets(): PresetsService | undefined;
    private llm;
    /** ACP modes = the deployment's agent-preset roster. */
    readModes(state: SessionState): Promise<SessionModeState>;
    /** The full ACP config-option list for one session (model + thought level). */
    buildConfigOptions(state: SessionState): Promise<SessionConfigOption[]>;
    /** Apply a modelId ("provider/model") to the session's mutable selection. */
    applyModel(state: SessionState, modelId: string): Promise<void>;
    /** Apply a reasoning-effort id to the session's mutable selection. */
    applyThoughtLevel(state: SessionState, effortId: string): Promise<void>;
    /** Enumerate every registered provider's models plus the current selection. */
    private readModelState;
    /** Selectable reasoning efforts of the currently selected model. */
    private readThoughtLevels;
}
//# sourceMappingURL=session-config.d.ts.map