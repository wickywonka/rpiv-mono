/**
 * local-cli-tts-adapter — TTS adapter for CLI-based engines (e.g. Piper).
 *
 * Expects a "Piper-like" invocation:
 *   <binary> --model <model> --speed <factor> --sentence "<text>"
 *
 * Configuration (from TtsServiceConfig):
 *   url:      path to the binary (e.g. "/usr/local/bin/piper")
 *   protocol: "local-cli"
 *   options:
 *     model?      path to the model file
 *     speed?      speed factor (default 1.0)
 */

import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import type { TtsAudioChunk, TtsClient, TtsServiceConfig, TtsStream } from "../tts-client.js";

const TTS_TIMEOUT_MS = 30_000;

function optStr(options: Record<string, string> | undefined, key: string, fallback: string): string {
	return options?.[key]?.trim() || fallback;
}

function optFloat(options: Record<string, string> | undefined, key: string, fallback: number): number {
	const raw = options?.[key]?.trim();
	if (!raw) return fallback;
	const v = Number.parseFloat(raw);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function createLocalCliTtsClient(config: TtsServiceConfig): TtsClient {
	const binary = config.url;
	const model = optStr(config.options, "model", "");
	const speed = optFloat(config.options, "speed", 1.0);

	function execFilePromise(file: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile(file, args, { timeout: TTS_TIMEOUT_MS }, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	async function speak(text: string): Promise<void> {
		if (!binary || !model) {
			throw new Error("local-cli TTS: binary or model not configured");
		}

		const speedFactor = speed >= 100 ? (speed / 150).toFixed(2) : String(speed);
		await execFilePromise(binary, ["--model", model, "--speed", speedFactor, "--sentence", text]);
	}

	const client: TtsClient = {
		createStream(): TtsStream {
			const parts: string[] = [];
			let done = false;

			return {
				async push(text: string): Promise<void> {
					if (done) throw new Error("Stream already ended");
					parts.push(text);
				},
				async end(): Promise<void> {
					if (done) return;
					done = true;
				},
				close(): void {
					done = true;
				},
				onChunk(_cb: (chunk: TtsAudioChunk) => void): void {
					// No-op for CLI-style adapter.
				},
				onEnd(_cb: () => void): void {
					// No-op.
				},
				onError(_cb: (err: Error) => void): void {
					// No-op.
				},
			};
		},

		async synthesize(text: string): Promise<Readable> {
			await speak(text);
			return new Readable({
				read() {
					this.push(null);
				},
			});
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			if (!binary) return { ok: false, message: "local-cli TTS: no binary configured" };
			// Assume available if binary path is set.
			return { ok: true };
		},

		close(): void {
			// No persistent resources.
		},
	};

	return client;
}
