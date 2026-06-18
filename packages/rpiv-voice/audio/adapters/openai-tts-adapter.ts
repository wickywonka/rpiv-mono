/**
 * openai-tts-adapter — TTS adapter for OpenAI-compatible endpoints.
 *
 * Configuration (from TtsServiceConfig):
 *   url:      base URL, e.g. "http://localhost:8766"
 *   protocol: "openai-tts"
 *   options:
 *     model?     model name
 *     voice?     voice name
 *     apiKey?    Bearer token (default "test123" for mlx-qwen3-asr compat)
 *     timeoutMs? per-request timeout
 */

import { Readable } from "node:stream";
import type { TtsAudioChunk, TtsClient, TtsServiceConfig, TtsStream } from "../tts-client.js";

function optStr(options: Record<string, string> | undefined, key: string, fallback: string): string {
	return options?.[key]?.trim() || fallback;
}

function optInt(options: Record<string, string> | undefined, key: string, fallback: number): number {
	const raw = options?.[key]?.trim();
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function createOpenaiTtsClient(config: TtsServiceConfig): TtsClient {
	const baseUrl = config.url.replace(/\/+$/, "");
	const model = optStr(config.options, "model", "");
	const voice = optStr(config.options, "voice", "");
	const apiKeyRaw = optStr(config.options, "apiKey", "test123").trim();
	const apiKey = apiKeyRaw || null;
	const timeoutMs = optInt(config.options, "timeoutMs", 60000);

	async function synthesizeRequest(text: string): Promise<Readable> {
		const url = `${baseUrl}/v1/audio/speech`;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const body: Record<string, unknown> = {
				model: model || undefined,
				input: text,
				voice: voice || undefined,
				response_format: "pcm",
			};

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errBody = await safeText(response).catch(() => "");
				throw new Error(`TTS HTTP ${response.status}: ${errBody || "unexpected error"}`);
			}

			if (!response.body) {
				throw new Error("TTS response has no body");
			}

			// Convert Web ReadableStream to Node Readable (for Node 18+ streams).
			return webStreamToNodeReadable(response.body);
		} catch (err: unknown) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(`TTS request timed out after ${timeoutMs} ms`);
			}
			if (err instanceof Error) throw err;
			throw new Error(`TTS request failed: ${String(err)}`);
		} finally {
			clearTimeout(timer);
		}
	}

	const client: TtsClient = {
		createStream(): TtsStream {
			// For OpenAI-compatible TTS, streaming is emulated:
			// accumulate text, then synthesize on end().
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
					// No-op: actual synthesis happens in synthesize().
				},
				close(): void {
					done = true;
				},
				onChunk(_cb: (chunk: TtsAudioChunk) => void): void {
					// No-op for batch-style adapter.
				},
				onEnd(_cb: () => void): void {
					// No-op for batch-style adapter.
				},
				onError(_cb: (err: Error) => void): void {
					// No-op for batch-style adapter.
				},
			};
		},

		async synthesize(text: string): Promise<Readable> {
			return await synthesizeRequest(text);
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
					message: `TTS reachable but /v1/models returned ${response.status}`,
				};
			} catch (err: unknown) {
				const reason = err instanceof Error ? err.message : String(err);
				return { ok: false, message: `TTS unreachable: ${reason}` };
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

/**
 * Convert a Web ReadableStream<Uint8Array> into a Node Readable stream.
 * Works in modern Node (18+) where fetch is native.
 */
function webStreamToNodeReadable(stream: ReadableStream<Uint8Array>): Readable {
	const reader = stream.getReader();
	return new Readable({
		async read() {
			try {
				const { done, value } = await reader.read();
				if (done) {
					this.push(null);
				} else {
					this.push(Buffer.from(value));
				}
			} catch (err) {
				this.destroy(err as Error);
			}
		},
	});
}
