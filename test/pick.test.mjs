import { strict as assert } from "node:assert";
import { supportsImages, pickVisionModel } from "../lib/pick.js";

let passed = 0;
function ok(condition, label) {
	assert.ok(condition, label);
	passed += 1;
}
function equal(actual, expected, label) {
	assert.deepStrictEqual(actual, expected, label);
	passed += 1;
}

// supportsImages — mirrors the api-proxy gate.
ok(supportsImages(void 0) === true, "undefined modalities are treated as capable");
ok(supportsImages(["text", "image"]) === true, "image in modalities is capable");
ok(supportsImages(["text"]) === false, "text-only modalities reject images");
ok(supportsImages([]) === false, "empty modalities reject images");

// pickVisionModel — empty candidates.
equal(pickVisionModel([], "deepseek-official", []), void 0, "no candidates → undefined");

// Preference order: preferred first, then same provider, then any.
const candidates = [
	{ provider: "provider-a", model: "vision-a" },
	{ provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" },
	{ provider: "provider-b", model: "vision-b" },
];

equal(
	pickVisionModel(candidates, "deepseek-official", []),
	{ provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" },
	"same-provider candidate preferred over any",
);
equal(
	pickVisionModel(candidates, "deepseek-official", [{ provider: "provider-b", model: "vision-b" }]),
	{ provider: "provider-b", model: "vision-b" },
	"configured preferred model beats same-provider",
);
equal(
	pickVisionModel(candidates, "unknown-provider", []),
	{ provider: "provider-a", model: "vision-a" },
	"no same-provider → first candidate",
);
equal(
	pickVisionModel(candidates, "unknown-provider", [{ provider: "missing", model: "nope" }]),
	{ provider: "provider-a", model: "vision-a" },
	"unmatched preferred falls through to first candidate",
);
equal(
	pickVisionModel(candidates, "", []),
	{ provider: "provider-a", model: "vision-a" },
	"empty current provider skips same-provider branch",
);
equal(
	pickVisionModel(candidates, "deepseek-official", [{ provider: "provider-a", model: "vision-a" }, { provider: "provider-b", model: "vision-b" }]),
	{ provider: "provider-a", model: "vision-a" },
	"preferred order is respected",
);
equal(
	pickVisionModel(candidates, "deepseek-official", [null, { provider: "provider-b", model: "vision-b" }]),
	{ provider: "provider-b", model: "vision-b" },
	"null entries in preferred are skipped",
);

console.log(`pick.test: ${passed} assertions passed`);
