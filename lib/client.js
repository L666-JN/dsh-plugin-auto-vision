// dsh-plugin-auto-vision — client half.
//
// Wraps the composer's `session.prompt` RPC: when a message contains image
// content, ensure the session's model can accept images (switching to a
// vision-capable model through the same `selectModel` RPC the model-seat UI
// uses), then restore the previous model once the running turn completes.
//
// Zero top-level dependencies: every service is reached through the plugin
// context, and the host half is contacted through the generic RPC caller
// (`ctx.connection.rpc.call`). If anything is missing or the host half is
// unavailable, every path degrades to the stock behavior — sending can never
// be broken by this plugin.
window.__ModuleLoader__.load({
	id: "dsh-plugin-auto-vision",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Give up waiting for the running turn to complete after this long. */
		const RESTORE_TIMEOUT_MS = 15 * 60 * 1000;
		const AUTO_VISION_ENDPOINT = "autoVision/ensure";

		/** Switch the session's model, keeping the model-seat UI in sync. */
		async function selectModel(ctx, connection, sessionId, selection) {
			const directories = ctx.get("modelDirectories");
			if (directories !== void 0) {
				try {
					const directory = directories.directoryFor(sessionId);
					if (typeof directory.select === "function") {
						await directory.select(selection);
						return { ok: true };
					}
				} catch {
					// fall through to the raw RPC
				}
			}
			try {
				const result = await connection.api.sessions.selectModel({
					sessionId,
					provider: selection.provider,
					model: selection.model,
					...(selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }),
				});
				return result?.result?.ok === true
					? { ok: true }
					: { ok: false, message: result?.result?.error?.message ?? "model switch failed" };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		}

		/**
		 * Ensure the session's current model can accept image input before the
		 * prompt is sent.
		 * @returns one of:
		 *  - `{kind:"pass"}` — nothing to do (already capable, no selection, or
		 *    the host half is unavailable: degrade to stock behavior);
		 *  - `{kind:"switched", previous}` — switched to the vision model now;
		 *  - `{kind:"already-switched", previous}` — the session is still on the
		 *    vision model this plugin switched to earlier (attach-time switch);
		 *  - `{kind:"error", message}` — could not switch; the send must stop.
		 */
		async function ensureVisionModel(ctx, connection, sessionId, state) {
			const models = await connection.api.sessions.models({ sessionId }).catch(() => ({ result: { ok: false } }));
			if (!models?.result?.ok) return { kind: "pass" };
			const current = models.result.value?.current;
			if (current === null || current === void 0) return { kind: "pass" };
			const recorded = state.get(sessionId);
			if (recorded !== void 0 && current.provider === recorded.vision.provider && current.model === recorded.vision.model) {
				return { kind: "already-switched", previous: recorded.previous };
			}
			let outcome;
			try {
				outcome = await connection.rpc.call("/api", AUTO_VISION_ENDPOINT, {
					args: { provider: current.provider, model: current.model },
				});
			} catch {
				// Host half missing or gateway unavailable — stock behavior.
				return { kind: "pass" };
			}
			if (!outcome?.ok) {
				return { kind: "error", message: outcome?.error?.message ?? "auto vision: no vision-capable model is available" };
			}
			const vision = outcome.value?.selection;
			if (outcome.value?.switched !== true || vision === void 0 || typeof vision.provider !== "string" || typeof vision.model !== "string") {
				return { kind: "error", message: "auto vision: invalid vision model recommendation" };
			}
			const result = await selectModel(ctx, connection, sessionId, vision);
			if (!result.ok) return { kind: "error", message: result.message };
			const previous = {
				provider: current.provider,
				model: current.model,
				...(current.reasoningEffort === void 0 ? {} : { reasoningEffort: current.reasoningEffort }),
			};
			state.set(sessionId, { previous, vision });
			return { kind: "switched", previous };
		}

		/** Restore the pre-image model after the vision turn completed. */
		async function performRestore(ctx, connection, sessionId, state) {
			const recorded = state.get(sessionId);
			if (recorded === void 0) return;
			const models = await connection.api.sessions.models({ sessionId }).catch(() => ({ result: { ok: false } }));
			if (!models?.result?.ok) return;
			const current = models.result.value?.current;
			if (current === null || current === void 0) return;
			if (current.provider !== recorded.vision.provider || current.model !== recorded.vision.model) {
				// The user (or something else) changed the model mid-turn — respect it.
				state.delete(sessionId);
				return;
			}
			if (current.provider === recorded.previous.provider && current.model === recorded.previous.model) {
				state.delete(sessionId);
				return;
			}
			const result = await selectModel(ctx, connection, sessionId, recorded.previous);
			if (result.ok) state.delete(sessionId);
		}

		/**
		 * Arm the restore: subscribe to the session snapshot and restore the
		 * previous model after the running turn completes (running true→false).
		 * Queue mode is handled naturally — `running` stays true until the whole
		 * queue drains, so the restore fires once at the end. Timeout and
		 * teardown guards prevent leaked subscriptions.
		 */
		function armRestore(ctx, connection, sessionId, state, pendingRestores) {
			if (pendingRestores.has(sessionId)) return; // an earlier image turn is already being watched
			const sessions = ctx.get("sessions");
			const session = sessions?.binding?.(sessionId)?.session;
			if (session === void 0 || typeof session.subscribe !== "function" || typeof session.getSnapshot !== "function") return;
			let off = () => {};
			let timer;
			let sawRunning = session.getSnapshot().running === true;
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				if (timer !== void 0) clearTimeout(timer);
				pendingRestores.delete(sessionId);
			};
			off = session.subscribe(() => {
				if (done) return;
				const running = session.getSnapshot().running;
				if (running) sawRunning = true;
				else if (sawRunning) {
					finish();
					off();
					void performRestore(ctx, connection, sessionId, state);
				}
			});
			timer = setTimeout(() => {
				off();
				finish();
			}, RESTORE_TIMEOUT_MS);
			pendingRestores.set(sessionId, { off, timer });
		}

		/** Proactive switch when an image is attached to the composer draft. */
		function setupAttachTimeSwitch(ctx, connection, state) {
			const sessions = ctx.get("sessions");
			const conversation = ctx.get("conversation");
			if (sessions === void 0 || conversation === void 0) return;
			const list = sessions.list;
			if (list === void 0 || typeof list.subscribe !== "function" || typeof list.getSnapshot !== "function") return;
			let currentSession;
			let offInput;
			const subscribeInput = () => {
				if (offInput !== void 0) {
					offInput();
					offInput = void 0;
				}
				if (currentSession === void 0) return;
				let shell;
				try {
					shell = conversation.input?.shell(currentSession);
				} catch {
					return;
				}
				if (shell === void 0 || shell.state === void 0 || typeof shell.state.subscribe !== "function") return;
				let hadImages = Array.isArray(shell.snapshot?.imageIds) && shell.snapshot.imageIds.length > 0;
				offInput = shell.state.subscribe(() => {
					const hasImages = Array.isArray(shell.snapshot?.imageIds) && shell.snapshot.imageIds.length > 0;
					if (hasImages && !hadImages) {
						// Proactive; failures surface (or fall back) at send time.
						void ensureVisionModel(ctx, connection, currentSession, state).catch(() => {});
					}
					hadImages = hasImages;
				});
			};
			const readCurrent = () => list.getSnapshot()?.current;
			currentSession = readCurrent();
			subscribeInput();
			const offList = list.subscribe(() => {
				const next = readCurrent();
				if (next !== currentSession) {
					currentSession = next;
					subscribeInput();
				}
			});
			ctx.effect(() => () => {
				offList();
				if (offInput !== void 0) offInput();
			}, "auto-vision: attach-time switch");
		}

		/**
		 * Client plugin body.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const connection = ctx.get("connection");
			if (connection === void 0 || connection.api === void 0 || typeof connection.api.sessions?.prompt !== "function" || typeof connection.rpc?.call !== "function") return;
			const state = /* @__PURE__ */ new Map();
			const pendingRestores = /* @__PURE__ */ new Map();
			const originalPrompt = connection.api.sessions.prompt;
			connection.api.sessions.prompt = async (request, signal) => {
				const content = request?.content;
				const hasImage = Array.isArray(content) && content.some((part) => part !== null && typeof part === "object" && part.type === "image");
				if (!hasImage) return originalPrompt(request, signal);
				const ensured = await ensureVisionModel(ctx, connection, request.sessionId, state);
				if (ensured.kind === "error") {
					return {
						rpcId: request.rpcId,
						result: {
							ok: false,
							error: {
								code: "attachment-error",
								message: ensured.message,
								details: { reason: "AUTO_VISION_NO_MODEL" },
							},
						},
					};
				}
				const result = await originalPrompt(request, signal);
				if (result?.result?.ok === true && (ensured.kind === "switched" || ensured.kind === "already-switched")) {
					armRestore(ctx, connection, request.sessionId, state, pendingRestores);
				}
				return result;
			};
			ctx.effect(() => () => {
				for (const pending of pendingRestores.values()) pending.off();
				pendingRestores.clear();
			}, "auto-vision: restore cleanup");
			setupAttachTimeSwitch(ctx, connection, state);
		}

		exports.apply = apply;
		return module.exports;
	},
});
