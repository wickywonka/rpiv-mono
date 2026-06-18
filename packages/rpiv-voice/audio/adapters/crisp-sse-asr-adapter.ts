/**
 * crisp-sse-asr-adapter — streaming ASR via CrispASR HTTP SSE endpoint.
 *
 * Protocol:
 *   - Endpoint: POST /v1/audio/transcriptions
 *   - Form field: `stream=true`
 *   - Response: text/event-stream
 *       data: {"text": "partial text..."}
 *       data: {"text": "final text..."}
 *       data: [DONE]
 *
 * Configuration (from AsrServiceConfig):
 *   url:      HTTP base URL, e.g. "http://192.168.5.10:8080"
 *   protocol: "crispasr-sse"
 *   options:
 *     model?     model name (ignored by CrispASR server)
 *     apiKey?    Bearer token
 *     timeoutMs? per-request timeout
 */

import type { AsrClient, AsrResult, AsrServiceConfig, AsrStream, AudioChunk } from "../asr-client.js";

const DEFAULT_TIMEOUT_MS = 30000;

function optStr(options: Record<string, string> | undefined, key: string, fallback: string): string {
	return options?.[key]?.trim() || fallback;
}

function optInt(options: Record<string, string> | undefined, key: string, fallback: number): number {
	const raw = options?.[key]?.trim();
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

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

// ── SSE parser ─────────────────────────────────────────────────────────────

interface SseEvent {
	data: string;
}

/**
 * Parse SSE text/event-stream into individual events.
 * Handles partial chunks (lines can be split across reads).
 */
function createSseParser(onEvent: (event: SseEvent) => void) {
	let buffer = "";
	let currentData = "";

	return (chunk: string) => {
		buffer += chunk;

		// Process complete lines.
		while (buffer.includes("\n")) {
			const nl = buffer.indexOf("\n");
			const line = buffer.slice(0, nl).trimEnd();
			buffer = buffer.slice(nl + 1);

			if (line === "") {
				// Empty line = event delimiter.
				if (currentData) {
					onEvent({ data: currentData });
					currentData = "";
				}
				continue;
			}

			if (line.startsWith("data:")) {
				const value = line.slice(5).trimStart();
				currentData += (currentData ? "\n" : "") + value;
			}
		}
	};
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export function createCrispSseAsrClient(config: AsrServiceConfig): AsrClient {
	const baseUrl = config.url.replace(/\/+$/, "");
	const apiKeyRaw = optStr(config.options, "apiKey", "").trim();
	const apiKey = apiKeyRaw || null;
	const timeoutMs = optInt(config.options, "timeoutMs", DEFAULT_TIMEOUT_MS);

	async function transcribeStreaming(
		wavData: Buffer,
		onText: (text: string, isFinal: boolean) => void,
		signal?: AbortSignal,
	): Promise<void> {
		const url = `${baseUrl}/v1/audio/transcriptions`;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		// Forward external abort.
		if (signal) {
			signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const formData = new FormData();
		formData.append("file", new Blob([wavData], { type: "audio/wav" }), "audio.wav");
		formData.append("stream", "true");

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
				const body = await safeText(response).catch(() => "");
				throw new Error(`ASR HTTP ${response.status}: ${body || "unexpected error"}`);
			}

			if (!response.body) {
				throw new Error("ASR response has no body");
			}

			// Parse SSE stream.
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let _isFinal = false;

			const parser = createSseParser((event) => {
				if (event.data === "[DONE]") {
					_isFinal = true;
					return;
				}

				try {
					const obj = JSON.parse(event.data);
					if (obj && typeof obj.text === "string") {
						onText(obj.text, false);
					}
				} catch {
					// Ignore non-JSON data lines.
				}
			});

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				parser(decoder.decode(value, { stream: true }));
			}

			// Flush remaining.
			parser(decoder.decode());
			// Signal end.
			onText("", true);
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
			// SSE is batch (one file → SSE stream).  Emulated.
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
				onResult(_cb: (r: AsrResult) => void): void {},
				onError(_cb: (err: Error) => void): void {},
			};
		},

		async recognize(samples: Float32Array, onPartial?: (text: string) => void): Promise<string> {
			if (samples.length === 0) return "";

			const wavData = float32ToWav(samples, 16000);
			let finalText = "";

			await transcribeStreaming(wavData, (text, isFinal) => {
				if (isFinal) {
					// Do nothing — final is signalled by [DONE], text is empty.
				} else {
					finalText = text;
					if (onPartial) onPartial(text);
				}
			});

			return finalText;
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			const url = `${baseUrl}/health`;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);

			try {
				const response = await fetch(url, {
					method: "GET",
					signal: controller.signal,
				});

				if (response.ok) return { ok: true };

				return {
					ok: false,
					message: `ASR /health returned ${response.status}`,
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
