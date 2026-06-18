/**
 * voice-config — unified settings for rpiv-voice.
 *
 * Layered resolution:
 *   1. ~/.pi/agent/settings.json → "rpiv-voice" key  (global)
 *   2. code defaults
 *
 * ASR/TTS are now configured as service lists (url + protocol).
 * Backward-compatible helpers translate legacy fields into service configs
 * so existing settings keep working without changes.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AsrServiceConfig } from "../audio/asr-client.js";
import type { TtsServiceConfig } from "../audio/tts-client.js";

// ── Filesystem layout ────────────────────────────────────────────────────────

const PI_GLOBAL_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "rpiv-voice";

// ── Config schema ────────────────────────────────────────────────────────────

export interface VoiceConfig {
	// ── ASR services (new, recommended) ────────────────────────────────────
	/**
	 * ASR service list, ordered by priority.
	 * Each entry only declares address and protocol.
	 */
	readonly asrServices?: AsrServiceConfig[];

	// ── TTS services (new, recommended) ───────────────────────────────────
	/**
	 * TTS service list, ordered by priority.
	 */
	readonly ttsServices?: TtsServiceConfig[];

	// ── Legacy STT fields (backward compatibility) ────────────────────────
	/** HuggingFace model ID or local path for STT engine. */
	readonly sttModelPath?: string;
	/** STT language hint (for sherpa-onnx). */
	readonly sttLanguage?: string;

	// ── Legacy TTS fields (backward compatibility) ────────────────────────
	/**
	 * @deprecated Use ttsServices instead.
	 */
	readonly ttsProvider?: "system" | "local" | "mlx-qwen3";
	/**
	 * @deprecated Use ttsServices instead.
	 */
	readonly ttsModelPath?: string;
	/**
	 * @deprecated Use ttsServices instead.
	 */
	readonly localTtsBinary?: string;
	/**
	 * @deprecated Use ttsServices instead.
	 */
	readonly localTtsModel?: string;
	/**
	 * @deprecated Use ttsServices instead.
	 */
	readonly mlxQwen3Speaker?: string;
	/**
	 * @deprecated Use ttsServices instead.
	 */
	readonly mlxQwen3Language?: string;

	// ── General ───────────────────────────────────────────────────────────
	readonly hallucinationFilterEnabled?: boolean;
	readonly equalizerEnabled?: boolean;
	readonly ttsEnabled?: boolean;
	readonly ttsSpeed?: number; // used as speed hint for system TTS
	readonly autoSpeakOnReply?: boolean;
	readonly autoSpeakMaxChars?: number;
	readonly voiceConvoSilenceTimeoutMs?: number;
	readonly voiceConvoMicReopenDelayMs?: number;
	readonly summaryPrompt?: string;
	readonly errorLogPath?: string;
}

// ── Accessors (stable public surface) ────────────────────────────────────────

export function isHallucinationFilterEnabled(config: { hallucinationFilterEnabled?: boolean }): boolean {
	return config.hallucinationFilterEnabled !== false;
}

export function isEqualizerEnabled(config: { equalizerEnabled?: boolean }): boolean {
	return config.equalizerEnabled === true;
}

export function isTtsEnabled(config: VoiceConfig): boolean {
	return config.ttsEnabled !== false;
}

export function isAutoSpeakOnReplyEnabled(config: VoiceConfig): boolean {
	return config.autoSpeakOnReply === true;
}

export function getAutoSpeakMaxChars(config: VoiceConfig): number {
	const v = config.autoSpeakMaxChars;
	if (typeof v === "number" && v > 0) return v;
	return 300;
}

export function getTtsSpeed(config: VoiceConfig): number {
	const v = config.ttsSpeed;
	if (typeof v === "number" && v >= 50 && v <= 600) return v;
	return 260;
}

export function getVoiceConvoSilenceTimeoutMs(config: VoiceConfig): number {
	const v = config.voiceConvoSilenceTimeoutMs;
	if (typeof v === "number" && v >= 200 && v <= 5000) return v;
	return 800;
}

export function getVoiceConvoMicReopenDelayMs(config: VoiceConfig): number {
	const v = config.voiceConvoMicReopenDelayMs;
	if (typeof v === "number" && v >= 0 && v <= 10000) return v;
	return 600;
}

export function getSummaryPrompt(config: VoiceConfig): string {
	return config.summaryPrompt ?? "用一句简短的中文口语总结你刚刚为用户做了什么，以及关键成果。";
}

// ── Resolve ASR services (new config + legacy compat) ────────────────────────

/**
 * Build the effective ASR service list from config.
 *
 * Priority:
 *  1) asrServices (if present)
 *  2) legacy fields → synthesized services
 */
export function resolveAsrServices(config: VoiceConfig, sherpaTokensPath: string): AsrServiceConfig[] {
	// If new-style config is present, use it directly.
	if (config.asrServices && config.asrServices.length > 0) {
		return config.asrServices;
	}

	const services: AsrServiceConfig[] = [];

	// Legacy: Qwen3-ASR via env (mlx-qwen3-asr serve)
	const qwen3AsrUrl = process.env.QWEN3_ASR_URL?.trim() || "http://localhost:8765";
	const qwen3AsrApiKey = process.env.QWEN3_ASR_API_KEY?.trim() || "test123" || null;
	const qwen3AsrModel = process.env.QWEN3_ASR_MODEL?.trim() || "Qwen/Qwen3-ASR-1.7B";
	const qwen3AsrTimeout = process.env.QWEN3_ASR_TIMEOUT?.trim() || "15000";

	if (qwen3AsrUrl) {
		services.push({
			url: qwen3AsrUrl,
			protocol: "openai-file",
			options: {
				model: qwen3AsrModel,
				apiKey: qwen3AsrApiKey ?? "",
				timeoutMs: qwen3AsrTimeout,
			},
		});
	}

	// Legacy: sherpa-onnx (SenseVoice) if sttModelPath is set.
	if (config.sttModelPath) {
		services.push({
			url: config.sttModelPath,
			protocol: "local-sherpa",
			options: {
				tokens: sherpaTokensPath,
				...(config.sttLanguage ? { language: config.sttLanguage } : {}),
			},
		});
	}

	// If nothing at all, provide a safe default pointing to local sherpa
	// (caller is expected to ensure model path).
	if (services.length === 0) {
		services.push({
			url: sherpaTokensPath, // placeholder; real path should be set externally
			protocol: "local-sherpa",
		});
	}

	return services;
}

// ── Resolve TTS services (new config + legacy compat) ────────────────────────

/**
 * Build the effective TTS service list from config.
 *
 * Priority:
 *  1) ttsServices (if present)
 *  2) legacy fields → synthesized services
 */
export function resolveTtsServices(config: VoiceConfig): TtsServiceConfig[] {
	// If new-style config is present, use it directly.
	if (config.ttsServices && config.ttsServices.length > 0) {
		return config.ttsServices;
	}

	const services: TtsServiceConfig[] = [];
	const speed = getTtsSpeed(config);

	const provider = config.ttsProvider || "system";

	if (provider === "mlx-qwen3" && config.ttsModelPath) {
		// Treat as OpenAI-compatible TTS endpoint.
		services.push({
			url: "http://localhost:8766", // default mlx-audio base; can be overridden via ttsServices
			protocol: "openai-tts",
			options: {
				model: config.ttsModelPath,
				voice: config.mlxQwen3Speaker || "",
				apiKey: "test123",
			},
		});
	}

	if (provider === "local" && config.localTtsBinary && config.localTtsModel) {
		services.push({
			url: config.localTtsBinary,
			protocol: "local-cli",
			options: {
				model: config.localTtsModel,
				speed: String(speed),
			},
		});
	}

	// Always include system TTS as a fallback (unless explicitly not wanted).
	services.push({
		url: "system",
		protocol: "system-tts",
		options: { speed: String(speed) },
	});

	return services;
}

// ── Layered config loader ────────────────────────────────────────────────────

function mergeInto(a: Record<string, unknown>, b: Record<string, unknown>): void {
	for (const key of Object.keys(b)) {
		const bv = b[key];
		if (bv !== null && typeof bv === "object" && !Array.isArray(bv)) {
			const av = a[key];
			if (av !== null && typeof av === "object" && !Array.isArray(av)) {
				mergeInto(av as Record<string, unknown>, bv as Record<string, unknown>);
				continue;
			}
		}
		a[key] = bv;
	}
}

function tryReadJson(path: string): Record<string, unknown> {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// missing / malformed → skip
	}
	return {};
}

function tryStat(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function tryMkdir(path: string): void {
	try {
		mkdirSync(path, { recursive: true });
	} catch {
		/* best-effort */
	}
}

export function loadVoiceConfig(): VoiceConfig {
	const merged: Record<string, unknown> = {};

	const globalSettings = tryReadJson(PI_GLOBAL_SETTINGS);
	const voiceSettings = globalSettings[SETTINGS_KEY];
	if (voiceSettings !== null && typeof voiceSettings === "object" && !Array.isArray(voiceSettings)) {
		mergeInto(merged, voiceSettings as Record<string, unknown>);
	}

	return merged as unknown as VoiceConfig;
}

export function saveVoiceConfig(config: VoiceConfig): boolean {
	try {
		const allSettings = tryReadJson(PI_GLOBAL_SETTINGS);
		allSettings[SETTINGS_KEY] = { ...((allSettings[SETTINGS_KEY] as object) ?? {}), ...config };
		const dir = dirname(PI_GLOBAL_SETTINGS);
		if (!tryStat(dir)) {
			tryMkdir(dir);
		}
		writeFileSync(PI_GLOBAL_SETTINGS, `${JSON.stringify(allSettings, null, "\t")}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}

// ── Internal ─────────────────────────────────────────────────────────────────

const VOICE_STATE_KEY = Symbol.for("rpiv-voice");

export function __resetState(): void {
	const g = globalThis as unknown as { [k: symbol]: unknown };
	delete g[VOICE_STATE_KEY];
}

export const TEST_CONFIG_PATH = PI_GLOBAL_SETTINGS;
