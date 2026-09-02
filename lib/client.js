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
		/** The wire endpoint the composer send path uses (session controller Remote). */
		const PROMPT_ENDPOINT = "session/prompt";

		/**
		 * Resolve the session Remote face (`remote.session`) from the plugin
		 * context, or undefined when the client gateway is not mounted yet.
		 */
		function sessionRemote(ctx) {
			try {
				const session = ctx.get("remote.session");
				if (session !== void 0 && typeof session === "object") return session;
			} catch {}
			try {
				const remote = ctx.get("remote");
				const session = remote?.session;
				return session !== void 0 && typeof session === "object" ? session : void 0;
			} catch {
				return void 0;
			}
		}

		/** Read the session's current model selection (UI-same source), or null. */
		async function readCurrentSelection(ctx, connection, sessionId) {
			try {
				const directories = ctx.get("modelDirectories");
				if (directories !== void 0) {
					const directory = directories.directoryFor(sessionId);
					const current = directory.store?.getSnapshot?.().current;
					if (current !== null && current !== void 0) return current;
				}
			} catch {}
			try {
				const session = sessionRemote(ctx);
				if (session !== void 0 && typeof session.modelCatalog === "function") {
					const catalog = await session.modelCatalog();
					const def = catalog?.value?.default;
					if (def !== void 0 && typeof def.provider === "string" && typeof def.model === "string") return def;
				}
			} catch {}
			return null;
		}

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
					// fall through to the session Remote RPC
				}
			}
			try {
				const session = sessionRemote(ctx);
				if (session === void 0 || typeof session.selectModel !== "function") {
					return { ok: false, message: "auto vision: session remote unavailable" };
				}
				const result = await session.selectModel({
					sessionId,
					provider: selection.provider,
					model: selection.model,
					...(selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }),
				});
				return result?.ok === true
					? { ok: true }
					: { ok: false, message: result?.error?.message ?? "model switch failed" };
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
			const current = await readCurrentSelection(ctx, connection, sessionId);
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
			const current = await readCurrentSelection(ctx, connection, sessionId);
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
			if (connection === void 0 || connection.rpc === void 0 || typeof connection.rpc.call !== "function") return;
			const state = /* @__PURE__ */ new Map();
			const pendingRestores = /* @__PURE__ */ new Map();
			const originalCall = connection.rpc.call;
			connection.rpc.call = async (channel, endpoint, payload, signal) => {
				let switchedSession;
				if (channel === "/api" && endpoint === PROMPT_ENDPOINT) {
					// The session/prompt Remote packs its single business argument
					// (SessionPromptRequest) under the wire field "request":
					//   payload = { args: { request: { requestId, sessionId, mode, content, clientTimeZone } } }
					// Tolerate a flat `args` too, in case the wire shape ever changes.
					const promptArgs = payload?.args?.request ?? payload?.args;
					const content = promptArgs?.content;
					const hasImage = Array.isArray(content) && content.some((part) => part !== null && typeof part === "object" && part.type === "image");
					if (hasImage && typeof promptArgs?.sessionId === "string") {
						const ensured = await ensureVisionModel(ctx, connection, promptArgs.sessionId, state);
						if (ensured.kind === "error") {
							return {
								ok: false,
								error: {
									code: "attachment-error",
									message: ensured.message,
									details: { reason: "AUTO_VISION_NO_MODEL" },
								},
							};
						}
						if (ensured.kind === "switched" || ensured.kind === "already-switched") {
							switchedSession = promptArgs.sessionId;
						}
					}
				}
				const result = await originalCall.call(connection.rpc, channel, endpoint, payload, signal);
				if (switchedSession !== void 0 && result?.ok === true) {
					armRestore(ctx, connection, switchedSession, state, pendingRestores);
				}
				return result;
			};
			ctx.effect(() => () => {
				if (connection.rpc.call !== originalCall) connection.rpc.call = originalCall;
				for (const pending of pendingRestores.values()) pending.off();
				pendingRestores.clear();
			}, "auto-vision: restore cleanup");
			setupAttachTimeSwitch(ctx, connection, state);
		}

		exports.apply = apply;
		return module.exports;
	},
});
