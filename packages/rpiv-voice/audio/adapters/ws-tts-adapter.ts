/**
 * ws-tts-adapter — streaming TTS over WebSocket.
 *
 * Protocol:
 *   - url:      WebSocket endpoint (ws:// or wss://)
 *   - protocol: "ws-streaming"
 *   - options:
 *       voice?      voice name hint
 *       language?   language hint
 *       timeoutMs?  connection / health-check timeout
 *
 * Behavior:
 *   - createStream():
 *       - opens WebSocket
 *       - sends START { role: "tts", voice, language }
 *       - push(text): sends TEXT_IN
 *       - end(): sends END
 *       - onChunk(cb): AUDIO_OUT
 *       - onEnd(cb): connection close
 *       - onError(cb): errors
 *   - synthesize(text):
 *       - batch-style: push text, end, return audio as Node Readable.
 */

import { Readable } from "node:stream";
import type { TtsAudioChunk, TtsClient, TtsServiceConfig, TtsStream } from "../tts-client.js";
import {
	createFrameDecoder,
	decodeTextOut,
	encodeEnd,
	encodeStart,
	encodeTextIn,
	TYPE_AUDIO_OUT,
	TYPE_ERROR,
} from "./ws-protocol.js";

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

export function createWsTtsClient(config: TtsServiceConfig): TtsClient {
	const url = config.url;
	const voice = optStr(config.options, "voice", "");
	const language = optStr(config.options, "language", "");
	const timeoutMs = optInt(config.options, "timeoutMs", DEFAULT_TIMEOUT_MS);

	function openWithTimeout(): Promise<{ socket: WebSocket; cancel: () => void }> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			const timer = setTimeout(() => {
				cancel();
				reject(new Error(`WebSocket TTS connection timed out after ${timeoutMs} ms`));
			}, timeoutMs);

			const cancel = () => {
				clearTimeout(timer);
				if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
					socket.close();
				}
			};

			socket.onopen = () => {
				clearTimeout(timer);
				resolve({ socket, cancel });
			};

			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error("WebSocket TTS connection failed"));
			};
		});
	}

	function sendBinary(socket: WebSocket, data: Uint8Array): void {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(data);
		}
	}

	const client: TtsClient = {
		createStream(): TtsStream {
			let socket: WebSocket | null = null;
			let cancelFn: (() => void) | null = null;
			let closed = false;

			const onChunkCbs: Array<(chunk: TtsAudioChunk) => void> = [];
			const onEndCbs: Array<() => void> = [];
			const onErrorCbs: Array<(err: Error) => void> = [];

			const decoder = createFrameDecoder((type, _flags, payload) => {
				if (type === TYPE_AUDIO_OUT) {
					for (const cb of onChunkCbs) {
						cb({ data: new Uint8Array(payload) });
					}
				} else if (type === TYPE_ERROR) {
					const msg = decodeTextOut(payload);
					for (const cb of onErrorCbs) {
						cb(new Error(`TTS error: ${msg}`));
					}
				}
			});

			(async () => {
				try {
					const { socket: ws, cancel } = await openWithTimeout();
					socket = ws;
					cancelFn = cancel;

					const startFrame = encodeStart({
						voice: voice || undefined,
						language: language || undefined,
					});
					sendBinary(ws, startFrame);

					ws.binaryType = "arraybuffer";

					ws.onmessage = (event: MessageEvent) => {
						if (event.data instanceof ArrayBuffer) {
							decoder.onData(new Uint8Array(event.data));
						}
					};

					ws.onerror = () => {
						for (const cb of onErrorCbs) {
							cb(new Error("WebSocket TTS connection error"));
						}
					};

					ws.onclose = () => {
						for (const cb of onEndCbs) {
							cb();
						}
					};
				} catch (err) {
					for (const cb of onErrorCbs) {
						cb(err instanceof Error ? err : new Error(String(err)));
					}
				}
			})();

			return {
				async push(text: string): Promise<void> {
					if (closed) throw new Error("Stream closed");
					if (!socket) throw new Error("Stream not initialized");
					const frame = encodeTextIn(text);
					sendBinary(socket, frame);
				},

				async end(): Promise<void> {
					if (closed) return;
					if (!socket) return;
					const frame = encodeEnd();
					sendBinary(socket, frame);
				},

				close(): void {
					if (closed) return;
					closed = true;
					if (cancelFn) {
						cancelFn();
						cancelFn = null;
					}
					if (socket) {
						try {
							socket.close();
						} catch {
							// ignore
						}
						socket = null;
					}
				},

				onChunk(cb: (chunk: TtsAudioChunk) => void): void {
					onChunkCbs.push(cb);
				},

				onEnd(cb: () => void): void {
					onEndCbs.push(cb);
				},

				onError(cb: (err: Error) => void): void {
					onErrorCbs.push(cb);
				},
			};
		},

		async synthesize(text: string): Promise<Readable> {
			if (!text || text.trim().length === 0) {
				return new Readable({
					read() {
						this.push(null);
					},
				});
			}

			return new Readable({
				async read() {
					let _socket: WebSocket | null = null;
					let cancelFn: (() => void) | null = null;
					let ended = false;

					try {
						const { socket: ws, cancel } = await openWithTimeout();
						_socket = ws;
						cancelFn = cancel;

						const startFrame = encodeStart({
							voice: voice || undefined,
							language: language || undefined,
						});
						sendBinary(ws, startFrame);

						const textFrame = encodeTextIn(text);
						sendBinary(ws, textFrame);

						const endFrame = encodeEnd();
						sendBinary(ws, endFrame);

						ws.binaryType = "arraybuffer";

						ws.onmessage = (event: MessageEvent) => {
							if (event.data instanceof ArrayBuffer) {
								this.push(Buffer.from(event.data));
							}
						};

						ws.onclose = () => {
							if (!ended) {
								ended = true;
								if (cancelFn) {
									cancelFn();
									cancelFn = null;
								}
								this.push(null);
							}
						};

						ws.onerror = () => {
							if (!ended) {
								ended = true;
								if (cancelFn) {
									cancelFn();
									cancelFn = null;
								}
								this.destroy(new Error("WebSocket TTS error"));
							}
						};
					} catch (err) {
						if (cancelFn) {
							cancelFn();
							cancelFn = null;
						}
						this.destroy(err instanceof Error ? err : new Error(String(err)));
					}
				},
			});
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			try {
				const { socket, cancel } = await openWithTimeout();
				const startFrame = encodeStart({ voice, language });
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(startFrame);
				}
				cancel();
				return { ok: true };
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				return { ok: false, message: `WebSocket TTS unreachable: ${reason}` };
			}
		},

		close(): void {
			// No persistent resources.
		},
	};

	return client;
}
