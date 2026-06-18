/**
 * openai-asr-adapter — ASR adapter for OpenAI-compatible endpoints.
 *
 * Supports:
 *   - "openai-file" protocol: upload WAV, get text (current Qwen3-ASR style)
 *   - "openai-streaming" protocol: future-ready (not yet implemented here)
 *
 * Configuration (from AsrServiceConfig):
 *   url:      base URL, e.g. "http://localhost:8765"
 *   protocol: "openai-file" | "openai-streaming"
 *   options:
 *     model?     model name
 *     apiKey?    Bearer token (default "test123" for mlx-qwen3-asr compat)
 *     timeoutMs? per-request timeout
 */

import type { AsrClient, AsrResult, AsrServiceConfig, AsrStream, AudioChunk } from "../asr-client.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function float32ToWav(samples: Float32Array, sampleRate: number): Buffer {
	const bits16 = samples.length * 2;
	const buffer = Buffer.alloc(44 + bits16);

	writeString(buffer, 0, "RIFF");
	writeUint32LE(buffer, 4, 36 + bits16);
	writeString(buffer, 8, "WAVE");
	writeString(buffer, 12, "fmt ");
	writeUint32LE(buffer, 16, 16);
	writeUint16LE(buffer, 20, 1);
	writeUint16LE(buffer, 22, 1);
	writeUint32LE(buffer, 24, sampleRate);
	writeUint32LE(buffer, 28, sampleRate * 2);
	writeUint16LE(buffer, 32, 2);
	writeUint16LE(buffer, 34, 16);
	writeString(buffer, 36, "data");
	writeUint32LE(buffer, 40, bits16);

	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		const v = s < 0 ? s * 0x8000 : s * 0x7fff;
		buffer.writeInt16LE(Math.round(v), 44 + i * 2);
	}

	return buffer;
}

function writeString(buf: Buffer, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
}

function writeUint32LE(buf: Buffer, offset: number, value: number): void {
	buf.writeUInt32LE(value, offset);
}

function writeUint16LE(buf: Buffer, offset: number, value: number): void {
	buf.writeUInt16LE(value, offset);
}

function optStr(options: Record<string, string> | undefined, key: string, fallback: string): string {
	return options?.[key]?.trim() || fallback;
}

function optInt(options: Record<string, string> | undefined, key: string, fallback: number): number {
	const raw = options?.[key]?.trim();
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── Adapter factory ────────────────────────────────────────────────────────

export function createOpenaiAsrClient(config: AsrServiceConfig): AsrClient {
	const baseUrl = config.url.replace(/\/+$/, "");
	const _protocol = config.protocol;
	const model = optStr(config.options, "model", "Qwen/Qwen3-ASR-1.7B");
	const apiKeyRaw = optStr(config.options, "apiKey", "test123").trim();
	const apiKey = apiKeyRaw || null;
	const timeoutMs = optInt(config.options, "timeoutMs", 15000);

	async function sendTranscription(wavData: Buffer): Promise<string> {
		const url = `${baseUrl}/v1/audio/transcriptions`;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const formData = new FormData();
		formData.append("model", model);
		formData.append("file", new Blob([wavData], { type: "audio/wav" }), "audio.wav");

		try {
			const response = await fetch(url, {
				method: "POST",
				body: formData,
				signal: controller.signal,
				headers: {
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
			});

			if (!response.ok) {
				const body = await safeText(response);
				throw new Error(`ASR HTTP ${response.status}: ${body || "unexpected error"}`);
			}

			const json = (await response.json()) as { text?: string };
			if (json && typeof json.text === "string") return json.text.trim();

			const raw = JSON.stringify(json);
			throw new Error(
				raw.length > 200 ? "ASR returned unexpected JSON shape" : `ASR returned unexpected JSON shape: ${raw}`,
			);
		} catch (err: unknown) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(`ASR request timed out after ${timeoutMs} ms`);
			}
			if (err instanceof Error) throw err;
			throw new Error(`ASR request failed: ${String(err)}`);
		} finally {
			clearTimeout(timer);
		}
	}

	const client: AsrClient = {
		createStream(): AsrStream {
			// For file-upload protocol, streaming is emulated:
			// accumulate chunks, then send on end().
			const chunks: Float32Array[] = [];
			const _sampleRate = 16000;
			let done = false;

			return {
				async push(chunk: AudioChunk): Promise<void> {
					if (done) throw new Error("Stream already ended");
					chunks.push(chunk.samples);
				},
				async end(): Promise<void> {
					if (done) return;
					done = true;
					// Implementation detail: this adapter doesn't wire
					// onResult callbacks for streaming mode yet.
				},
				close(): void {
					done = true;
				},
				onResult(_cb: (r: AsrResult) => void): void {
					// No-op for batch-style adapters.
				},
				onError(_cb: (err: Error) => void): void {
					// No-op for batch-style adapters.
				},
			};
		},

		async recognize(samples: Float32Array, _onPartial?: (text: string) => void): Promise<string> {
			if (samples.length === 0) return "";
			const wavData = float32ToWav(samples, 16000);
			return await sendTranscription(wavData);
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			const url = `${baseUrl}/v1/models`;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);

			try {
				const response = await fetch(url, {
					method: "GET",
					signal: controller.signal,
					headers: {
						...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
					},
				});

				if (response.ok) return { ok: true };

				return {
					ok: false,
					message: `ASR reachable but /v1/models returned ${response.status}`,
				};
			} catch (err: unknown) {
				const reason = err instanceof Error ? err.message : String(err);
				return { ok: false, message: `ASR unreachable: ${reason}` };
			} finally {
				clearTimeout(timer);
			}
		},

		close(): void {
			// No persistent resources.
		},
	};

	return client;
}

async function safeText(response: Response): Promise<string> {
	try {
		return (await response.text()).trim();
	} catch {
		return "";
	}
}
