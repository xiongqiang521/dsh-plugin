import { ErrorCode, } from "../acp/types.js";
import { RpcRequestError } from "../acp/transport.js";
/** Config-option ids advertised in session/new (pi-acp uses the same pair). */
export const MODEL_CONFIG_ID = "model";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
/** Encode one provider/model pair as an ACP model-id. */
function modelIdOf(provider, model) {
    return provider + "/" + model;
}
/** Decode an ACP model-id ("provider/model") back into its parts. */
function parseModelId(modelId) {
    const slash = modelId.indexOf("/");
    if (slash <= 0 || slash === modelId.length - 1) {
        throw new RpcRequestError(ErrorCode.InvalidParams, "invalid modelId (expected provider/model): " + modelId);
    }
    return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}
/**
 * Whether a session carries model-visible conversation content (seed and
 * lifecycle markers do not count — only actual prompts, model output, tool
 * work, or a closed turn do).
 */
export function hasProducedContent(session) {
    return session.events.some((event) => event.type === "user/message" ||
        event.type === "assistant/message" ||
        event.type === "tool/result" ||
        event.type === "turn/end");
}
export class SessionConfigService {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    presets() {
        return this.ctx.get("agentPresets");
    }
    llm() {
        return this.ctx.get("llm");
    }
    /** ACP modes = the deployment's agent-preset roster. */
    async readModes(state) {
        const presets = this.presets();
        if (!presets) {
            return { currentModeId: state.presetId ?? "default", availableModes: [] };
        }
        let availableModes;
        try {
            availableModes = (await presets.list())
                .filter((preset) => !preset.broken)
                .map((preset) => ({
                id: preset.id,
                name: preset.name ?? preset.id,
                description: preset.description ?? null,
            }));
        }
        catch {
            availableModes = [];
        }
        let currentModeId = state.presetId;
        if (!currentModeId) {
            try {
                currentModeId = (await presets.resolve()).id;
            }
            catch {
                currentModeId = availableModes[0]?.id ?? "default";
            }
        }
        return { currentModeId, availableModes };
    }
    /** The full ACP config-option list for one session (model + thought level). */
    async buildConfigOptions(state) {
        const options = [];
        const modelState = await this.readModelState(state);
        if (modelState) {
            options.push({
                type: "select",
                id: MODEL_CONFIG_ID,
                category: "model",
                name: "Model",
                description: "Select the model for this session",
                currentValue: modelState.currentModelId,
                options: modelState.availableModels.map((model) => ({
                    value: model.modelId,
                    name: model.name,
                    description: model.description ?? null,
                })),
            });
        }
        const thoughtState = await this.readThoughtLevels(state);
        if (thoughtState) {
            options.push({
                type: "select",
                id: THOUGHT_LEVEL_CONFIG_ID,
                category: "thought_level",
                name: "Thinking",
                description: "Set the reasoning effort for this session",
                currentValue: thoughtState.currentEffort,
                options: thoughtState.efforts.map((effort) => ({
                    value: effort.id,
                    name: effort.name,
                    description: effort.description ?? null,
                })),
            });
        }
        return options;
    }
    /** Apply a modelId ("provider/model") to the session's mutable selection. */
    async applyModel(state, modelId) {
        const { provider, model } = parseModelId(modelId);
        const llm = this.llm();
        if (llm) {
            const providers = llm.listProviders();
            if (!providers.some((entry) => entry.id === provider)) {
                throw new RpcRequestError(ErrorCode.InvalidParams, "unknown provider: " + provider);
            }
            const catalog = await llm.listModels(provider).catch(() => null);
            if (catalog && !catalog.some((entry) => entry.id === model)) {
                throw new RpcRequestError(ErrorCode.InvalidParams, "unknown model: " + modelId);
            }
        }
        // A new model's reasoning vocabulary may differ — drop the old effort and
        // re-resolve the context window at the next enumeration.
        state.selection.current = { provider, model };
        state.contextWindow = undefined;
    }
    /** Apply a reasoning-effort id to the session's mutable selection. */
    async applyThoughtLevel(state, effortId) {
        const current = state.selection.current;
        if (!current) {
            throw new RpcRequestError(ErrorCode.InvalidParams, "no model selected");
        }
        const llm = this.llm();
        let valid = true;
        if (llm) {
            try {
                const info = await llm.resolveModelInfo(current.provider, current.model);
                valid = (info.reasoning?.efforts ?? []).some((effort) => String(effort.id) === effortId);
            }
            catch {
                valid = true; // un-resolvable catalog: accept and let the adapter judge
            }
        }
        if (!valid) {
            throw new RpcRequestError(ErrorCode.InvalidParams, "unknown thought level: " + effortId);
        }
        state.selection.current = { ...current, reasoningEffort: effortId };
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    /** Enumerate every registered provider's models plus the current selection. */
    async readModelState(state) {
        const current = state.selection.current;
        if (!current)
            return null;
        const currentModelId = modelIdOf(current.provider, current.model);
        const models = [];
        const llm = this.llm();
        if (llm) {
            const providers = llm.listProviders();
            const lists = await Promise.allSettled(providers.map((provider) => llm.listModels(provider.id)));
            for (let i = 0; i < providers.length; i++) {
                const provider = providers[i];
                const result = lists[i];
                if (result.status !== "fulfilled")
                    continue;
                for (const model of result.value) {
                    models.push({
                        modelId: modelIdOf(provider.id, model.id),
                        name: `${provider.name}/${model.name ?? model.id}`,
                        description: model.description,
                    });
                }
            }
        }
        // Always surface the active selection, even when its route is not
        // enumerable (e.g. an adapter with no live catalog).
        if (!models.some((model) => model.modelId === currentModelId)) {
            models.unshift({
                modelId: currentModelId,
                name: `${current.provider}/${current.model}`,
                description: "Currently selected model",
            });
        }
        return { availableModels: models, currentModelId };
    }
    /** Selectable reasoning efforts of the currently selected model. */
    async readThoughtLevels(state) {
        const current = state.selection.current;
        const llm = this.llm();
        if (!current || !llm)
            return null;
        let efforts = [];
        let defaultEffort;
        try {
            const info = await llm.resolveModelInfo(current.provider, current.model);
            // Advertise the model's real context window in usage_update when known.
            const window = info.context?.contextWindow;
            if (typeof window === "number" && Number.isFinite(window) && window > 0) {
                state.contextWindow = window;
            }
            efforts = (info.reasoning?.efforts ?? []).map((effort) => ({
                id: String(effort.id),
                name: effort.name,
                description: effort.description,
            }));
            defaultEffort = info.reasoning?.defaultEffort !== undefined ? String(info.reasoning.defaultEffort) : undefined;
        }
        catch {
            return null;
        }
        if (efforts.length === 0)
            return null;
        const selected = current.reasoningEffort !== undefined ? String(current.reasoningEffort) : defaultEffort;
        return {
            efforts,
            currentEffort: selected ?? efforts[0].id,
        };
    }
}
//# sourceMappingURL=session-config.js.map