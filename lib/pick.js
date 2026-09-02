/**
 * Pure selection helpers for the auto-vision plugin.
 *
 * Zero-dependency module (no DSH imports) so the pick logic can be unit-tested
 * with plain Node.
 *
 * @module dsh-plugin-auto-vision/pick
 */

/**
 * Whether a model metadata `inputModalities` list accepts image input.
 *
 * Mirrors the api-proxy gate exactly: `undefined` (unknown) is treated as
 * capable — the gate only rejects when the list is explicitly present and
 * lacks `"image"`.
 * @param modalities - the model's declared input modalities, if any.
 * @returns true when image input is not explicitly excluded.
 */
export function supportsImages(modalities) {
	return modalities === void 0 || modalities.includes("image");
}

/**
 * Pick the recommended vision model from a flat candidate list.
 *
 * Preference order: configured preferred models (in list order), then a
 * candidate from the current provider, then the first candidate.
 * @param candidates - flat vision-capable model entries ({provider, model}).
 * @param currentProvider - provider of the current selection (may be empty).
 * @param preferred - ordered configured preferred models ({provider, model}).
 * @returns the picked entry, or undefined when no candidate exists.
 */
export function pickVisionModel(candidates, currentProvider, preferred = []) {
	if (candidates.length === 0) return void 0;
	for (const item of preferred) {
		if (item === void 0 || item === null) continue;
		const match = candidates.find(
			(candidate) => candidate.provider === item.provider && candidate.model === item.model,
		);
		if (match !== void 0) return match;
	}
	if (currentProvider !== void 0 && currentProvider !== "") {
		const sameProvider = candidates.find((candidate) => candidate.provider === currentProvider);
		if (sameProvider !== void 0) return sameProvider;
	}
	return candidates[0];
}
