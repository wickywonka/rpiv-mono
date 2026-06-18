/**
 * sherpa-asr-adapter — ASR adapter for sherpa-onnx (SenseVoice).
 *
 * Configuration (from AsrServiceConfig):
 *   url:      path to the model file (e.g. model.int8.onnx)
 *   protocol: "local-sherpa"
 *   options:
 *     tokens?       path to tokens.txt
 *     language?     language hint
 *     useItn?       "true"/"false"
 *     numThreads?   thread count
 *     provider?     "cpu" (default)
 */

import type { Config as SherpaConfig } from "sherpa-onnx-node";
import type { AsrClient, AsrResult, AsrServiceConfig, AsrStream, AudioChunk } from "../asr-client.js";

const SAMPLE_RATE = 16000;
const FEATURE_DIM = 80;
const DEFAULT_NUM_THREADS = 4;
const DEFAULT_PROVIDER = "cpu";

function optStr(options: Record<string, string> | undefined, key: string, fallback: string): string {
	return options?.[key]?.trim() || fallback;
}

function optInt(options: Record<string, string> | undefined, key: string, fallback: number): number {
	const raw = options?.[key]?.trim();
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

function optBool(options: Record<string, string> | undefined, key: string, fallback: boolean): boolean {
	const raw = options?.[key]?.trim().toLowerCase();
	if (raw === "false" || raw === "0" || raw === "no") return false;
	if (raw === "true" || raw === "1" || raw === "yes") return true;
	return fallback;
}

export function createSherpaAsrClient(config: AsrServiceConfig): AsrClient {
	const modelPath = config.url;
	const tokensPath = optStr(config.options, "tokens", "");
	const language = optStr(config.options, "language", "");
	const useItn = optBool(config.options, "useItn", true);
	const numThreads = optInt(config.options, "numThreads", DEFAULT_NUM_THREADS);
	const provider = optStr(config.options, "provider", DEFAULT_PROVIDER);

	let sherpa: { OfflineRecognizer: typeof import("sherpa-onnx-node").OfflineRecognizer };

	async function ensureSherpa() {
		if (sherpa) return sherpa;
		const mod = (await import("sherpa-onnx-node")) as Record<string, unknown> & {
			default?: Record<string, unknown>;
		};
		sherpa = (mod.default ?? mod) as {
			OfflineRecognizer: typeof import("sherpa-onnx-node").OfflineRecognizer;
		};
		return sherpa;
	}

	function buildSherpaConfig(): SherpaConfig {
		return {
			featConfig: {
				sampleRate: SAMPLE_RATE,
				featureDim: FEATURE_DIM,
			},
			modelConfig: {
				senseVoice: {
					model: modelPath,
					...(language ? { language } : {}),
					useItn,
				},
				tokens: tokensPath,
				numThreads,
				provider,
			},
		};
	}

	async function extractText(raw: string): Promise<string> {
		if (!raw) return "";
		try {
			const obj = JSON.parse(raw);
			if (obj && typeof obj.text === "string") return obj.text.trim();
		} catch {
			// Not JSON — treat as plain text.
		}
		return raw.trim();
	}

	const client: AsrClient = {
		createStream(): AsrStream {
			// sherpa-onnx offline recognizer is batch-oriented;
			// streaming here is emulated by buffering then decoding.
			const chunks: Float32Array[] = [];
			let done = false;

			return {
				async push(chunk: AudioChunk): Promise<void> {
					if (done) throw new Error("Stream already ended");
					chunks.push(chunk.samples);
				},
				async end(): Promise<void> {
					if (done) return;
					done = true;
				},
				close(): void {
					done = true;
				},
				onResult(_cb: (r: AsrResult) => void): void {
					// No-op for batch-style adapter.
				},
				onError(_cb: (err: Error) => void): void {
					// No-op for batch-style adapter.
				},
			};
		},

		async recognize(samples: Float32Array, _onPartial?: (text: string) => void): Promise<string> {
			if (samples.length === 0) return "";
			const ns = await ensureSherpa();
			const recognizer = new ns.OfflineRecognizer(buildSherpaConfig());
			const stream = recognizer.createStream();
			stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
			recognizer.decode(stream);
			const result = recognizer.getResult(stream);
			return await extractText(result.text);
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			// Local model: assume healthy if import succeeds.
			try {
				await ensureSherpa();
				return { ok: true };
			} catch (err: unknown) {
				return {
					ok: false,
					message: `sherpa-onnx unavailable: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},

		close(): void {
			// sherpa-onnx-node is GC-managed; no explicit shutdown.
		},
	};

	return client;
}
