import { TypertRemoteService, Remote } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { pickVisionModel, supportsImages } from "./pick.js";

/**
 * dsh-plugin-auto-vision — host half.
 *
 * Exposes the `autoVision/ensure` Remote endpoint (typert SRC discovery through
 * {@link TypertRemoteService} + the manually installed {@link Remote} marker).
 * The endpoint is a pure query: it reports whether a given provider/model
 * selection can accept image input and, when it cannot, recommends a
 * vision-capable model from the provider catalog.
 *
 * Switching itself is deliberately left to the client half through the existing
 * `session.selectModel` RPC: the live per-session selection lives inside the
 * api-proxy (`selectionFor`) and is not reachable from a host plugin, while the
 * client can drive the same RPC the model-seat UI uses.
 *
 * @module dsh-plugin-auto-vision
 */

/** Configuration rendered in 设置 → 插件 for this plugin. */
const AUTO_VISION_CONFIG = z.object({
	enabled: z.boolean().default(true),
	preferredModels: z.array(z.object({
		provider: z.string().required(),
		model: z.string().required(),
	})).default([]),
});

/** Cap on per-provider `resolveModelInfo` confirmations inside one scan. */
const VISION_CANDIDATE_CONFIRM_LIMIT = 40;

/**
 * Auto vision model recommendation service.
 */
class AutoVisionService extends TypertRemoteService {
	static Config = AUTO_VISION_CONFIG;
	static inject = ["llm"];
	constructor(ctx, config) {
		super(ctx, "autoVision");
		this.config = config;
	}
	/**
	 * Check the current selection and, when it cannot accept images, recommend a
	 * vision-capable model. The recommendation is advisory; the client performs
	 * the switch through `session.selectModel`.
	 * @param provider - provider of the current selection.
	 * @param model - model id of the current selection.
	 * @returns `{ switched: false }` when the current model is fine, otherwise
	 * `{ switched: true, selection }` with the recommended vision model.
	 * @throws {Error} when no vision-capable model is available (the typert
	 * gateway folds the throw into a typed `{ ok: false }` result).
	 */
	async ensure(provider, model) {
		if (this.config.enabled === false) return { switched: false };
		const llm = this.ctx.llm;
		let currentOk = true;
		try {
			const info = await llm.resolveModelInfo(provider, model);
			currentOk = supportsImages(info.inputModalities);
		} catch {
			// Unknown metadata mirrors the api-proxy gate, which only rejects
			// when inputModalities is explicitly present and lacks "image".
			currentOk = true;
		}
		if (currentOk) return { switched: false };
		const preferred = this.config.preferredModels ?? [];
		const candidates = await this.collectVisionCandidates(llm);
		const pick = pickVisionModel(candidates, provider, preferred);
		if (pick === void 0) {
			const scope = provider === void 0 || provider === "" ? "" : ` for provider "${provider}"`;
			throw new Error(`no vision-capable model is available${scope}`);
		}
		return { switched: true, selection: { ...pick } };
	}
	/**
	 * Scan the provider catalog for models that accept image input. Uses the
	 * adapter's `listModels` modality metadata when present and confirms
	 * unknown-modality models through `resolveModelInfo`. One provider's catalog
	 * failure never breaks the scan.
	 * @param llm - the mounted LLM runtime service.
	 * @returns flat vision-capable model entries in provider order.
	 */
	async collectVisionCandidates(llm) {
		const candidates = [];
		const seen = /* @__PURE__ */ new Set();
		const push = (provider, model) => {
			const key = `${provider}\u0000${model}`;
			if (seen.has(key)) return;
			seen.add(key);
			candidates.push({ provider, model });
		};
		const providers = llm.listProviders();
		for (const entry of providers) {
			let models;
			try {
				models = await llm.listModels(entry.id);
			} catch {
				continue;
			}
			const unknown = [];
			for (const model of models) {
				if (model.inputModalities !== void 0) {
					if (model.inputModalities.includes("image")) push(entry.id, model.id);
				} else {
					unknown.push(model.id);
				}
			}
			for (const modelId of unknown.slice(0, VISION_CANDIDATE_CONFIRM_LIMIT)) {
				try {
					const info = await llm.resolveModelInfo(entry.id, modelId);
					if (supportsImages(info.inputModalities)) push(entry.id, modelId);
				} catch {
					// unresolvable model — skip
				}
			}
		}
		return candidates;
	}
}

// Install the typert Remote marker for SRC discovery. `@Remote()` is decorator
// sugar from the compile step of in-tree packages; this package ships plain
// ESM, so the marker is installed manually through the exact `addInitializer`
// contract the decorator uses. The initializer runs with `this` bound to an
// object whose prototype is AutoVisionService.prototype, so `mark` lands on
// the prototype table the typert gateway reads via `remoteMethods`.
Remote(AutoVisionService.prototype.ensure, {
	kind: "method",
	name: "ensure",
	private: false,
	static: false,
	addInitializer(initializer) {
		initializer.call(Object.create(AutoVisionService.prototype));
	},
});

export { AutoVisionService, supportsImages };
export default AutoVisionService;
