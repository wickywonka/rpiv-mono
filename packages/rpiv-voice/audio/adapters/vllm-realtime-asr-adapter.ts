/**
 * vllm-realtime-asr-adapter — streaming ASR via vLLM Realtime WebSocket API.
 *
 * Endpoint: ws://host:port/v1/realtime
 *
 * Protocol (OpenAI Realtime API compatible):
 *   Client → Server (JSON text frames):
 *     session.update     — init session, set model
 *     input_audio_buffer.append  — audio chunk (base64 PCM16 @ 16kHz)
 *     input_audio_buffer.commit  — end of utterance
 *
 *   Server → Client (JSON text frames):
 *     session.created / session.updated  — session ack
 *     transcription.delta     — partial text delta  {"type":"transcription.delta","delta":"..."}
 *     transcription.done      — transcription complete
 *     response.done           — response complete
 *     error                   — error
 *
 * Audio format: PCM16 (signed 16-bit LE), 16kHz mono, base64-encoded.
 *
 * Configuration (from AsrServiceConfig):
 *   url:      WebSocket base, e.g. "ws://192.168.5.10:8000"
 *   protocol: "vllm-realtime"
 *   options:
 *     model?      model name (sent in session.update)
 *     timeoutMs?  connection timeout
 */

import type { AsrClient, AsrResult, AsrServiceConfig, AsrStream, AudioChunk } from "../asr-client.js";

const DEFAULT_TIMEOUT_MS = 5000;

function optStr(options: Record<string, string> | undefined, key: string, fallback: string): string {
	return options?.[key]?.trim() || fallback;
}

function optInt(options: Record<string, string> | undefined, key: string, fallback: number): number {
	const raw = options?.[key]?.trim();
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Recommended chunk duration per the vLLM Realtime spec (§5.2). */
const CHUNK_MS = 200;
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = Math.round((SAMPLE_RATE * CHUNK_MS) / 1000); // 3200

// ── Float32 → base64 PCM16 conversion ─────────────────────────────────────

function float32ToBase64Pcm16(samples: Float32Array): string {
	const buf = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		const v = s < 0 ? s * 0x8000 : s * 0x7fff;
		buf.writeInt16LE(Math.round(v), i * 2);
	}
	return buf.toString("base64");
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export function createVllmRealtimeAsrClient(config: AsrServiceConfig): AsrClient {
	const url = config.url.replace(/\/+$/, "");
	const model = optStr(config.options, "model", "");
	const timeoutMs = optInt(config.options, "timeoutMs", DEFAULT_TIMEOUT_MS);

	function openWebSocket(path: string): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const wsUrl = `${url}${path}`;
			const socket = new WebSocket(wsUrl);
			const timer = setTimeout(() => {
				if (socket.readyState === WebSocket.CONNECTING) socket.close();
				reject(new Error(`vLLM WebSocket timed out after ${timeoutMs} ms`));
			}, timeoutMs);

			socket.onopen = () => {
				clearTimeout(timer);
				resolve(socket);
			};

			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error("vLLM WebSocket connection failed"));
			};
		});
	}

	function sendJson(socket: WebSocket, data: unknown): void {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(data));
		}
	}

	const client: AsrClient = {
		createStream(): AsrStream {
			let socket: WebSocket | null = null;
			let closed = false;
			let ready = false;

			const onResultCbs: Array<(r: AsrResult) => void> = [];
			const onErrorCbs: Array<(err: Error) => void> = [];

			let sessionId = "";

			const wsReady: Promise<void> = openWebSocket("/v1/realtime")
				.then((ws) => {
					socket = ws;

					return new Promise<void>((resolve, _reject) => {
						ws.onmessage = (event: MessageEvent) => {
							if (typeof event.data !== "string") return;

							try {
								const msg = JSON.parse(event.data);
								const type = msg.type;

								if (type === "session.created" || type === "session.updated") {
									if (msg.id && typeof msg.id === "string") {
										sessionId = msg.id;
									}
									ready = true;
									resolve();
								} else if (
									(type === "transcription.delta" || type === "response.audio_transcript.delta") &&
									msg.delta
								) {
									for (const cb of onResultCbs) {
										cb({ text: msg.delta as string, final: false });
									}
								} else if (
									type === "transcription.done" ||
									type === "response.audio_transcript.done" ||
									type === "conversation.item.input_audio_transcription.completed"
								) {
									const finalText = (msg.text as string) || (msg.transcript as string) || "";
									const usage = msg.usage
										? {
												audioTokens: (msg.usage.audio_tokens as number) ?? 0,
												outputTokens: (msg.usage.output_tokens as number) ?? 0,
											}
										: undefined;
									for (const cb of onResultCbs) {
										cb({
											text: finalText,
											final: true,
											sessionId: sessionId || undefined,
											usage,
										});
									}
								} else if (type === "error") {
									const errMsg = msg.message || msg.error || "vLLM error";
									for (const cb of onErrorCbs) {
										cb(new Error(errMsg));
									}
								}
							} catch {
								// Non-JSON — ignore.
							}
						};

						ws.onerror = () => {
							for (const cb of onErrorCbs) {
								cb(new Error("vLLM WebSocket error"));
							}
						};

						ws.onclose = (event: { wasClean: boolean; code: number; reason?: string }) => {
							if (!event.wasClean && ready) {
								for (const cb of onErrorCbs) {
									cb(
										new Error(
											`vLLM WebSocket closed unexpectedly (code=${event.code}, reason=${event.reason || "none"})`,
										),
									);
								}
							}
						};

						// Send session.update first.
						sendJson(ws, {
							type: "session.update",
							model: model || undefined,
						});
					});
				})
				.catch((err) => {
					for (const cb of onErrorCbs) {
						cb(err instanceof Error ? err : new Error(String(err)));
					}
				});

			return {
				async push(chunk: AudioChunk): Promise<void> {
					if (closed) throw new Error("Stream closed");
					await wsReady;
					if (!socket || !ready) throw new Error("Stream not initialized");
					const b64 = float32ToBase64Pcm16(chunk.samples);
					sendJson(socket, {
						type: "input_audio_buffer.append",
						audio: b64,
					});
				},

				async end(): Promise<void> {
					if (closed) return;
					await wsReady;
					if (!socket || !ready) return;
					sendJson(socket, {
						type: "input_audio_buffer.commit",
						final: true,
					});
				},

				close(): void {
					if (closed) return;
					closed = true;
					if (socket) {
						try {
							socket.close();
						} catch {
							/* ignore */
						}
						socket = null;
					}
				},

				onResult(cb: (r: AsrResult) => void): void {
					onResultCbs.push(cb);
				},

				onError(cb: (err: Error) => void): void {
					onErrorCbs.push(cb);
				},
			};
		},

		async recognize(samples: Float32Array, onPartial?: (text: string) => void): Promise<string> {
			if (samples.length === 0) return "";

			return new Promise<string>((resolve, reject) => {
				const stream = this.createStream();
				let collected = "";
				let done = false;
				let timer: ReturnType<typeof setTimeout> | null = null;

				const finish = (text: string) => {
					if (done) return;
					done = true;
					if (timer) clearTimeout(timer);
					stream.close();
					resolve(text);
				};

				const fail = (err: Error) => {
					if (done) return;
					done = true;
					if (timer) clearTimeout(timer);
					stream.close();
					reject(err);
				};

				stream.onResult((r) => {
					if (r.final) {
						// Prefer the server-provided final text; fall back to
						// collected deltas when the server sends an empty text.
						finish(r.text || collected);
					} else {
						collected += r.text;
						if (onPartial) onPartial(collected);
					}
				});

				stream.onError(fail);

				timer = setTimeout(() => {
					if (!done) finish(collected || "");
				}, timeoutMs * 4);

				// Send audio in recommended 200ms chunks (§5.2).
				(async () => {
					try {
						for (let offset = 0; offset < samples.length && !done; offset += CHUNK_SAMPLES) {
							const chunk = samples.slice(offset, offset + CHUNK_SAMPLES);
							await stream.push({ samples: chunk });
						}
						if (!done) await stream.end();
					} catch (err) {
						fail(err instanceof Error ? err : new Error(String(err)));
					}
				})();
			});
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			try {
				const socket = await openWebSocket("/v1/realtime");
				socket.close();
				return { ok: true };
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				return { ok: false, message: `vLLM WebSocket unreachable: ${reason}` };
			}
		},

		close(): void {},
	};

	return client;
}
