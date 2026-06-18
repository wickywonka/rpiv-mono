import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendErrorLog } from "../audio/error-log.js";
import { isHallucination } from "../audio/hallucination-filter.js";
import { createMic, type DecibriLike } from "../audio/mic-source.js";
import {
	assertModelIntact,
	ensureModelDownloaded,
	getModelPaths,
	isModelDownloaded,
	ModelInstallError,
	removeModelInstall,
} from "../audio/model-download.js";
import {
	bufferToFloat32,
	computeRmsFloat32 as computeRmsFloat32Pcm,
	computeRmsInt16 as computeRmsInt16Pcm,
} from "../audio/pcm.js";
import { createSttEngine, type SttEngine } from "../audio/stt-engine.js";
import { isTtsActive, stopActiveTts } from "../audio/tts-playback.js";
import {
	getVoiceConvoMicReopenDelayMs,
	getVoiceConvoSilenceTimeoutMs,
	isHallucinationFilterEnabled,
	loadVoiceConfig,
} from "../config/voice-config.js";
import { t } from "../state/i18n-bridge.js";
import type { VoiceResult } from "../state/state-reducer.js";
import { setVoiceConvoActive } from "../state/voice-mode.js";
import { VoiceSession } from "../state/voice-session.js";
import type { SplashPhase } from "../view/components/splash-view.js";
import { STATUS_BAR_PULSE_FRAME_INTERVAL_MS } from "../view/components/status-bar-view.js";
import { startDictationPipeline } from "./pipeline-runner.js";
import { runWithSplash } from "./splash-runner.js";

export const VOICE_COMMAND_NAME = "voice";

const SPLASH_INITIAL_ENGINE: SplashPhase = { kind: "loading_engine" };
function splashInitialDownload(): SplashPhase {
	return { kind: "downloading", message: t("splash.preparing", "Preparing model…") };
}

type PreflightStage = "download" | "extract" | "verify" | "stale_install" | "engine" | "mic";

class PreflightError extends Error {
	constructor(
		public readonly stage: PreflightStage,
		cause: unknown,
	) {
		super(`preflight failed at ${stage}`, { cause: cause as Error });
	}
}

interface Preflight {
	sttEngine: SttEngine;
	mic: DecibriLike;
}

export function registerVoiceCommand(pi: ExtensionAPI): void {
	registerDictationCommand(pi);
	registerVoiceConvoCommand(pi);
}

function registerDictationCommand(pi: ExtensionAPI): void {
	pi.registerCommand(VOICE_COMMAND_NAME, {
		description: t("command.description", "Dictate text with your voice — local STT, no cloud"),
		handler: (_args: string, ctx: ExtensionCommandContext) => handleVoiceCommand(ctx),
	});
}

function registerVoiceConvoCommand(pi: ExtensionAPI): void {
	pi.registerCommand("voice-convo", {
		description: "Continuous voice conversation mode: listen → send → hear summary → listen again. Esc to exit.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/voice-convo requires interactive mode", "error");
				return;
			}

			const preflight = await runPreflight(ctx);
			if (!preflight) return;

			await runVoiceConvoSession(pi, ctx, preflight.sttEngine, preflight.mic);
		},
	});
}

async function handleVoiceCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(t("error.requires_interactive", "/voice requires interactive mode"), "error");
		return;
	}

	const preflight = await runPreflight(ctx);
	if (!preflight) return;

	const result = await runDictationSession(ctx, preflight.sttEngine, preflight.mic);
	if (result.intent === "commit" && result.transcript) {
		ctx.ui.pasteToEditor(result.transcript);
	}
}

async function runPreflight(ctx: ExtensionCommandContext): Promise<Preflight | null> {
	try {
		return await runWithSplash<Preflight>(
			ctx,
			{ initialPhase: isModelDownloaded() ? SPLASH_INITIAL_ENGINE : splashInitialDownload() },
			async (controller) => {
				if (!isModelDownloaded()) {
					try {
						await ensureModelDownloaded((p) => {
							const message = p.message ?? "";
							if (p.phase === "downloading")
								controller.setPhase({
									kind: "downloading",
									message,
									percent: p.percent,
									bytesReceived: p.bytesReceived,
									totalBytes: p.totalBytes,
								});
							else if (p.phase === "extracting") controller.setPhase({ kind: "extracting", message });
							else if (p.phase === "verifying") controller.setPhase({ kind: "verifying", message });
						});
					} catch (e) {
						const stage = e instanceof ModelInstallError ? e.stage : "download";
						throw new PreflightError(stage, e);
					}
				}

				controller.setPhase({ kind: "loading_engine" });
				let sttEngine: SttEngine;
				try {
					// The sentinel proves a *prior* run finished cleanly — it does not
					// guarantee the .onnx files are still present and valid. Re-verify
					// here so a tampered/partially-deleted install gets caught with a
					// clear message + auto-recovery instead of an opaque native crash
					// deep inside sherpa-onnx.
					try {
						assertModelIntact();
					} catch (e) {
						removeModelInstall();
						throw new PreflightError("stale_install", e);
					}
					const paths = getModelPaths();
					// STT engine is created from config (asrServices).
					// Backends, priorities, and fallback are handled internally.
					sttEngine = createSttEngine(paths.tokensPath);
				} catch (e) {
					// Preserve the inner stage tag (e.g. "stale_install") instead of
					// flattening every failure in this block to "engine" — the user-
					// facing copy in preflightUserMessage diverges per stage.
					if (e instanceof PreflightError) throw e;
					throw new PreflightError("engine", e);
				}

				controller.setPhase({ kind: "initializing_mic" });
				let mic: DecibriLike;
				try {
					mic = await createMic();
				} catch (e) {
					sttEngine.release();
					throw new PreflightError("mic", e);
				}

				return { sttEngine, mic };
			},
		);
	} catch (e) {
		if (e instanceof PreflightError) {
			ctx.ui.notify(preflightUserMessage(e.stage), "error");
		} else {
			ctx.ui.notify(t("error.engine_load_failed", "Failed to load STT model."), "error");
		}
		return null;
	}
}

function preflightUserMessage(stage: PreflightStage): string {
	switch (stage) {
		case "download":
			return t("error.model_download_failed", "Failed to download STT model. Check your internet connection.");
		case "extract":
			return t("error.model_extract_failed", "Downloaded STT model archive is corrupt. Please retry.");
		case "verify":
			return t("error.model_verify_failed", "STT model files are incomplete after download. Please retry.");
		case "stale_install":
			return t(
				"error.model_stale_install",
				"STT model files were removed or corrupted. They will be redownloaded on next launch.",
			);
		case "engine":
			return t("error.engine_load_failed", "Failed to load STT model.");
		case "mic":
			return t(
				"error.mic_unavailable",
				"Microphone unavailable. Check that an input device is connected and that Pi has microphone permission.",
			);
	}
}

async function runDictationSession(
	ctx: ExtensionCommandContext,
	sttEngine: SttEngine,
	mic: DecibriLike,
): Promise<VoiceResult> {
	const controller = new AbortController();
	const persistedConfig = loadVoiceConfig();

	let pipelineHandle:
		| {
				setPaused: (v: boolean) => void;
				setHallucinationFilterEnabled: (v: boolean) => void;
				stop: () => void;
		  }
		| undefined;
	let pulseTick: ReturnType<typeof setInterval> | undefined;

	const result = await ctx.ui.custom<VoiceResult>((tui, theme, _kb, done) => {
		const session = new VoiceSession({
			tui,
			theme,
			persistedConfig,
			deps: {
				pasteToEditor: (text) => ctx.ui.pasteToEditor(text),
				notify: (message, level) => ctx.ui.notify(message, level),
				abort: () => controller.abort(),
				stopMic: () => pipelineHandle?.stop(),
				setPipelinePaused: (paused) => pipelineHandle?.setPaused(paused),
				setHallucinationFilterEnabled: (enabled) => pipelineHandle?.setHallucinationFilterEnabled(enabled),
			},
			done,
		});
		pipelineHandle = startDictationPipeline(mic, sttEngine, session, controller.signal, {
			hallucinationFilterEnabled: isHallucinationFilterEnabled(persistedConfig),
		});
		pulseTick = setInterval(() => session.tickPulse(), STATUS_BAR_PULSE_FRAME_INTERVAL_MS);
		return session.component;
	});

	if (pulseTick) clearInterval(pulseTick);
	if (!controller.signal.aborted) controller.abort();
	sttEngine.release();
	return result;
}

// ── /voice-convo: continuous voice conversation mode (voice assistant style) ──

async function runVoiceConvoSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	sttEngine: SttEngine,
	_mic: DecibriLike,
): Promise<void> {
	const controller = new AbortController();
	const persistedConfig = loadVoiceConfig();

	// Let index.ts know we're in voice-convo mode so it gates LLM summaries.
	setVoiceConvoActive(true);

	// Show a persistent overlay for conversation mode.
	await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
		const convoState = {
			status: "listening" as "listening" | "transcribing" | "sending" | "waiting" | "exiting",
			lastTranscript: "",
			equalizerLevels: new Array(20).fill(0),
			currentMic: null as any,
		};

		const requestRender = () => {
			tui.requestRender();
		};

		const startListening = async () => {
			if (controller.signal.aborted) return;

			// Don't open the mic while TTS is playing — otherwise the model
			// hears its own voice and starts an echo loop.
			if (isTtsActive()) {
				convoState.status = "waiting";
				requestRender();
				const poll = setInterval(() => {
					if (controller.signal.aborted || !isTtsActive()) {
						clearInterval(poll);
						if (!controller.signal.aborted) startListening();
					}
				}, 200);
				return;
			}

			// Stop previous mic if exists
			if (convoState.currentMic) {
				try {
					convoState.currentMic.stop();
				} catch {}
			}

			convoState.status = "listening";
			const audioChunks: Buffer[] = [];
			let silenceTimer: ReturnType<typeof setTimeout> | null = null;
			let isListening = true;

			try {
				const mic = await createMic();
				convoState.currentMic = mic;

				mic.on("data", (chunk: Buffer) => {
					if (!isListening) return;
					audioChunks.push(chunk);

					// Update equalizer visualization
					const rms = computeRmsInt16Pcm(chunk);
					convoState.equalizerLevels.shift();
					convoState.equalizerLevels.push(Math.min(1, rms * 20));
					requestRender();
				});

				mic.on("speech", () => {
					if (!isListening) return;
					if (silenceTimer) {
						clearTimeout(silenceTimer);
						silenceTimer = null;
					}
				});

				mic.on("silence", () => {
					if (!isListening) return;
					if (silenceTimer) return; // Already scheduled

					// On silence, transcribe and send
					silenceTimer = setTimeout(async () => {
						if (!isListening || audioChunks.length === 0) {
							silenceTimer = null;
							return;
						}
						silenceTimer = null;

						isListening = false;
						mic.stop();

						convoState.status = "transcribing";
						requestRender();

						const transcript = await transcribeAudio(audioChunks, sttEngine, persistedConfig);

						if (transcript && !controller.signal.aborted) {
							convoState.lastTranscript = transcript;
							convoState.status = "sending";
							requestRender();

							// Send as user message (triggers model response)
							pi.sendUserMessage(transcript);

							// Wait for model to finish responding, then restart listening
							convoState.status = "waiting";
							requestRender();

							// Poll until model is idle, then restart listening
							const checkAndRestart = setInterval(() => {
								if (controller.signal.aborted) {
									clearInterval(checkAndRestart);
									return;
								}
								if (ctx.isIdle()) {
									clearInterval(checkAndRestart);
									// Brief delay so agent_end + TTS have time to fire
									// before we open the mic, closing the race window.
									setTimeout(() => startListening(), getVoiceConvoMicReopenDelayMs(persistedConfig));
								}
							}, 500);
						} else if (!controller.signal.aborted) {
							// No transcript produced (empty audio, ASR failure, hallucination
							// filtered, or transcription timed out).  Restart listening so the
							// user can try again instead of being stuck at "⏳ Transcribing…".
							setTimeout(() => startListening(), getVoiceConvoMicReopenDelayMs(persistedConfig));
						}
					}, getVoiceConvoSilenceTimeoutMs(persistedConfig)); // Wait silence before transcribing
				});

				(mic as any).on("error", (_err: unknown) => {
					if (isListening) {
						isListening = false;
						convoState.status = "exiting";
						requestRender();
						setTimeout(() => done(), 500);
					}
				});
			} catch (err) {
				appendErrorLog("voice-convo.mic", err);
				convoState.status = "exiting";
				requestRender();
				setTimeout(() => done(), 500);
			}
		};

		// Start initial listening
		startListening().catch(() => {
			convoState.status = "exiting";
			requestRender();
			setTimeout(() => done(), 500);
		});

		// Render the conversation UI
		return {
			render: (w: number) => {
				const lines: string[] = [];

				// Header
				lines.push("Voice Conversation Mode — Esc to exit");
				lines.push("");

				// Status indicator
				const statusText = getStatusText(convoState.status);
				lines.push(statusText);
				lines.push("");

				// Equalizer visualization
				if (convoState.status === "listening") {
					const eqLine = buildEqualizerLine(convoState.equalizerLevels);
					lines.push(eqLine);
				}

				// Last transcript
				if (convoState.lastTranscript) {
					lines.push("");
					const wrapped = wrapText(convoState.lastTranscript, w - 2);
					lines.push(...wrapped);
				}

				return lines;
			},
			invalidate: () => requestRender(),
			handleInput: (data: string) => {
				// Space: stop TTS playback (key interrupt). Keeps voice-convo running.
				if (data === " ") {
					stopActiveTts();
					convoState.status = "listening";
					requestRender();
					return;
				}
				// ESC to exit (check multiple possible representations)
				if (data === "\x1b" || data === "escape" || data.charCodeAt(0) === 27) {
					controller.abort();
					if (convoState.currentMic) {
						try {
							convoState.currentMic.stop();
						} catch {}
					}
					done();
				}
			},
		};
	});

	setVoiceConvoActive(false);
	if (!controller.signal.aborted) controller.abort();
	sttEngine.release();
}

function getStatusText(status: string): string {
	switch (status) {
		case "listening":
			return "🎤 Listening... (speak now)";
		case "transcribing":
			return "⏳ Transcribing...";
		case "sending":
			return "📤 Sending your message...";
		case "waiting":
			return "⏳ Waiting for response...";
		case "exiting":
			return "Exiting...";
		default:
			return "...";
	}
}

function buildEqualizerLine(levels: number[]): string {
	const barChars = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	return levels.map((v) => barChars[Math.min(barChars.length - 1, Math.floor(v * (barChars.length - 1)))]).join("");
}

function wrapText(text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	let currentLine = "";

	// Detect character type: CJK vs non-CJK.
	const isCjk = (c: string): boolean => {
		const cp = c.codePointAt(0)!;
		return (
			(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
			(cp >= 0x3040 && cp <= 0x309f) || // Hiragana
			(cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
			(cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
			(cp >= 0x3000 && cp <= 0x303f) || // CJK Punctuation
			(cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
			(cp >= 0x2000 && cp <= 0x206f) // General Punctuation
		);
	};

	// Check if the text is predominantly CJK.
	let cjkCount = 0;
	for (let i = 0; i < text.length; i++) {
		if (isCjk(text[i]!)) cjkCount++;
	}
	const isCjkText = cjkCount > text.length * 0.3;

	if (isCjkText) {
		// Character-level wrapping for CJK text.
		for (const ch of [...text]) {
			if (ch === "\n") {
				lines.push(currentLine.trim());
				currentLine = "";
				continue;
			}
			// Each CJK character counts as roughly 2 ASCII widths in terminal.
			// Conservative: just count each char as 1.
			if (currentLine.length >= maxWidth) {
				lines.push(currentLine.trim());
				currentLine = ch;
			} else {
				currentLine += ch;
			}
		}
	} else {
		// Word-level wrapping for Latin/space-separated text.
		const words = text.split(/\s+/);
		for (const word of words) {
			if (`${currentLine} ${word}`.trim().length > maxWidth) {
				if (currentLine) {
					lines.push(currentLine.trim());
				}
				currentLine = word;
			} else {
				currentLine = `${currentLine} ${word}`.trim();
			}
		}
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines;
}

async function transcribeAudio(
	chunks: Buffer[],
	sttEngine: SttEngine,
	config: ReturnType<typeof loadVoiceConfig>,
): Promise<string> {
	if (chunks.length === 0) return "";

	const audio = Buffer.concat(chunks);
	const samples = bufferToFloat32(audio);

	// Check if there's enough audio content
	const rms = computeRmsFloat32Pcm(samples);
	if (rms < 0.005) return ""; // Too quiet, likely noise

	try {
		const result = await sttEngine.recognize(samples, 16000);
		const text = (result.text || "").trim();

		// Apply hallucination filter if enabled
		if (isHallucinationFilterEnabled(config) && isHallucination(text)) {
			return "";
		}

		return text;
	} catch (err) {
		appendErrorLog("voice-convo.transcribe", err);
		return "";
	}
}
