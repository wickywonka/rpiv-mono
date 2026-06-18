/**
 * ws-asr-adapter — streaming ASR over WebSocket.
 *
 * Protocol:
 *   - url:      WebSocket endpoint (ws:// or wss://)
 *   - protocol: "ws-streaming"
 *   - options:
 *       model?      model name hint
 *       timeoutMs?  connection / health-check timeout
 *
 * Behavior:
 *   - createStream():
 *       - opens WebSocket
 *       - sends START { role: "asr", model }
 *       - exposes push(end-of-utterance via end())
 *       - onResult(cb): partial/final text
 *       - onError(cb): connection or protocol errors
 *   - recognize(samples):
 *       - batch-style: push all samples, end, collect final text.
 */

import type { AsrClient, AsrResult, AsrServiceConfig, AsrStream, AudioChunk } from "../asr-client.js";
import {
	createFrameDecoder,
	decodeTextOut,
	encodeAudioIn,
	encodeEnd,
	encodeStart,
	FLAG_FINAL,
	TYPE_ERROR,
	TYPE_TEXT_OUT,
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

export function createWsAsrClient(config: AsrServiceConfig): AsrClient {
	const url = config.url;
	const model = optStr(config.options, "model", "");
	const timeoutMs = optInt(config.options, "timeoutMs", DEFAULT_TIMEOUT_MS);

	function openWithTimeout(): Promise<{ socket: WebSocket; cancel: () => void }> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			const timer = setTimeout(() => {
				cancel();
				reject(new Error(`WebSocket ASR connection timed out after ${timeoutMs} ms`));
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
				reject(new Error("WebSocket ASR connection failed"));
			};
		});
	}

	function sendBinary(socket: WebSocket, data: Uint8Array): void {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(data);
		}
	}

	const client: AsrClient = {
		createStream(): AsrStream {
			let socket: WebSocket | null = null;
			let cancelFn: (() => void) | null = null;
			let closed = false;

			const onResultCbs: Array<(r: AsrResult) => void> = [];
			const onErrorCbs: Array<(err: Error) => void> = [];

			const decoder = createFrameDecoder((type, flags, payload) => {
				if (type === TYPE_TEXT_OUT) {
					const text = decodeTextOut(payload);
					const final = (flags & FLAG_FINAL) !== 0;
					for (const cb of onResultCbs) {
						cb({ text, final });
					}
				} else if (type === TYPE_ERROR) {
					const msg = decodeTextOut(payload);
					for (const cb of onErrorCbs) {
						cb(new Error(`ASR error: ${msg}`));
					}
				}
			});

			(async () => {
				try {
					const { socket: ws, cancel } = await openWithTimeout();
					socket = ws;
					cancelFn = cancel;

					const startFrame = encodeStart({ model: model || undefined });
					sendBinary(ws, startFrame);

					ws.binaryType = "arraybuffer";

					ws.onmessage = (event: MessageEvent) => {
						if (event.data instanceof ArrayBuffer) {
							decoder.onData(new Uint8Array(event.data));
						}
					};

					ws.onerror = () => {
						for (const cb of onErrorCbs) {
							cb(new Error("WebSocket ASR connection error"));
						}
					};

					ws.onclose = () => {
						// Stream ended.
					};
				} catch (err) {
					for (const cb of onErrorCbs) {
						cb(err instanceof Error ? err : new Error(String(err)));
					}
				}
			})();

			return {
				async push(chunk: AudioChunk): Promise<void> {
					if (closed) throw new Error("Stream closed");
					if (!socket) throw new Error("Stream not initialized");
					const frame = encodeAudioIn(chunk.samples);
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

				onResult(cb: (r: AsrResult) => void): void {
					onResultCbs.push(cb);
				},

				onError(cb: (err: Error) => void): void {
					onErrorCbs.push(cb);
				},
			};
		},

		async recognize(samples: Float32Array, _onPartial?: (text: string) => void): Promise<string> {
			if (samples.length === 0) return "";

			return new Promise<string>((resolve, reject) => {
				const stream = this.createStream();
				let fullText = "";
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
					fullText = r.text;
					if (r.final) {
						finish(fullText);
					}
				});

				stream.onError((err) => {
					fail(err);
				});

				// Fallback timeout: if server never sends final, use last text.
				timer = setTimeout(() => {
					if (!done) {
						finish(fullText || "");
					}
				}, timeoutMs * 2);

				// Push all samples in one chunk.
				stream.push({ samples }).catch((err) => {
					fail(err instanceof Error ? err : new Error(String(err)));
				});

				stream.end().catch(() => {
					// ignore
				});
			});
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			try {
				const { socket, cancel } = await openWithTimeout();
				const startFrame = encodeStart({ model });
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(startFrame);
				}
				// Consider it healthy if we can open and send.
				cancel();
				return { ok: true };
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				return { ok: false, message: `WebSocket ASR unreachable: ${reason}` };
			}
		},

		close(): void {
			// No persistent resources.
		},
	};

	return client;
}
