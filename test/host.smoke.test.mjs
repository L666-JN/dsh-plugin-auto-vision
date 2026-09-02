import { strict as assert } from "node:assert";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { AutoVisionService, supportsImages } from "../lib/index.js";

let passed = 0;
function ok(condition, label) {
	assert.ok(condition, label);
	passed += 1;
}
function equal(actual, expected, label) {
	assert.deepStrictEqual(actual, expected, label);
	passed += 1;
}

const fakeLlm = {
	listProviders: () => [
		{ id: "deepseek-official", name: "DeepSeek" },
		{ id: "provider-x", name: "Provider X" },
	],
	listModels: async (provider) => {
		if (provider === "deepseek-official") {
			return [
				{ provider, id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", inputModalities: ["text"] },
				{ provider, id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision", inputModalities: ["text", "image"] },
			];
		}
		if (provider === "provider-x") {
			return [{ provider, id: "unknown-model", name: "Unknown" }]; // no modalities → resolve path
		}
		return [];
	},
	resolveModelInfo: async (provider, model) => {
		if (provider === "provider-x" && model === "unknown-model") return { provider, id: model, name: "Unknown", inputModalities: ["image"] };
		if (provider === "deepseek-official" && model === "deepseek-v4-flash") return { provider, id: model, name: "Flash", inputModalities: ["text"] };
		if (provider === "deepseek-official" && model === "deepseek-v4-flash-vision-exp") {
			return { provider, id: model, name: "Vision", inputModalities: ["text", "image"] };
		}
		throw new Error("unknown model");
	},
};

function makeCtx() {
	return { llm: fakeLlm, reflect: { provide() {} } };
}

// supportsImages
ok(supportsImages(void 0) === true, "unknown modalities are capable");
ok(supportsImages(["text", "image"]) === true, "image capable");
ok(supportsImages(["text"]) === false, "text-only rejects");

// Service shape + typert binding + Remote marker installation.
const service = new AutoVisionService(makeCtx(), { enabled: true, preferredModels: [] });
ok(service.typertRemote !== void 0, "typertRemote binding installed");
equal(service.typertRemote.namespace, "autoVision", "namespace is autoVision");
equal(service.typertRemote.serviceKey, "autoVision", "serviceKey is autoVision");
const markers = remoteMethods(service);
ok(Array.isArray(markers) && markers.some((marker) => marker.method === "ensure"), "Remote marker for ensure installed");

// ensure: current model already capable.
equal(await service.ensure("deepseek-official", "deepseek-v4-flash-vision-exp"), { switched: false }, "already vision-capable → switched:false");

// ensure: current model not capable, same-provider vision model exists.
equal(
	await service.ensure("deepseek-official", "deepseek-v4-flash"),
	{ switched: true, selection: { provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" } },
	"switches to same-provider vision model",
);

// ensure: preferred model wins.
const preferred = new AutoVisionService(makeCtx(), {
	enabled: true,
	preferredModels: [{ provider: "provider-x", model: "unknown-model" }],
});
equal(
	await preferred.ensure("deepseek-official", "deepseek-v4-flash"),
	{ switched: true, selection: { provider: "provider-x", model: "unknown-model" } },
	"preferred model wins over same-provider",
);

// ensure: enabled=false short-circuits.
const disabled = new AutoVisionService(makeCtx(), { enabled: false, preferredModels: [] });
equal(await disabled.ensure("deepseek-official", "deepseek-v4-flash"), { switched: false }, "disabled → switched:false");

// ensure: no vision model anywhere → throws.
const noVision = new AutoVisionService(
	{
		llm: {
			listProviders: () => [{ id: "only", name: "Only" }],
			listModels: async () => [{ provider: "only", id: "text-only", name: "Text", inputModalities: ["text"] }],
			resolveModelInfo: async () => ({ provider: "only", id: "text-only", name: "Text", inputModalities: ["text"] }),
		},
		reflect: { provide() {} },
	},
	{ enabled: true, preferredModels: [] },
);
await assert.rejects(() => noVision.ensure("only", "text-only"), /no vision-capable model/, "throws when no vision model exists");

// collectVisionCandidates: metadata fast path + resolveModelInfo fallback.
const candidates = await service.collectVisionCandidates(fakeLlm);
equal(
	candidates,
	[
		{ provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" },
		{ provider: "provider-x", model: "unknown-model" },
	],
	"catalog scan collects vision models (fast path + resolve fallback)",
);

console.log(`host.smoke.test: ${passed} assertions passed`);
