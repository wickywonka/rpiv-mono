/**
 * stt-engine — thin wrapper over AsrClient for rpiv-voice.
 *
 * Responsibilities:
 *   - Wire config → AsrClient via asr-factory.
 *   - Provide a stable recognize() interface to the rest of rpiv-voice.
 *   - No direct dependency on specific backends (Qwen3-ASR, sherpa-onnx, etc.).
 */

import { loadVoiceConfig, resolveAsrServices } from "../config/voice-config.js";
import type { AsrClient } from "./asr-client.js";
import { createAsrClientFromConfig } from "./asr-factory.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface SttBackendResult {
	text: string;
	/**
	 * Backend identifier is now opaque (e.g. "openai-file@http://..." or "local-sherpa@...").
	 * Callers should not depend on a fixed enum.
	 */
	backend: string;
}

export interface SttEngine {
	recognize(samples: Float32Array, sampleRate: number, onPartial?: (text: string) => void): Promise<SttBackendResult>;
	release(): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an STT engine from the current VoiceConfig.
 *
 * The caller provides:
 *   - sherpaTokensPath: path to tokens.txt for local sherpa-onnx fallback.
 *
 * All backend selection, health checks, and fallback logic live in asr-factory.
 */
export function createSttEngine(sherpaTokensPath: string): SttEngine {
	const config = loadVoiceConfig();
	const services = resolveAsrServices(config, sherpaTokensPath);
	const client: AsrClient = createAsrClientFromConfig(services);

	return {
		async recognize(
			samples: Float32Array,
			_sampleRate: number,
			onPartial?: (text: string) => void,
		): Promise<SttBackendResult> {
			if (samples.length === 0) {
				return { text: "", backend: "none" };
			}

			const text = await client.recognize(samples, onPartial);
			// backend label is derived from the active service; we expose a stable tag.
			return { text, backend: "asr" };
		},

		release(): void {
			client.close();
		},
	};
}
