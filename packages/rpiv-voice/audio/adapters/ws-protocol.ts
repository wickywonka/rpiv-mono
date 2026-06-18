/**
 * ws-protocol — binary frame protocol for streaming ASR/TTS over WebSocket.
 *
 * Frame layout (big-endian integers):
 *   - type:       1 byte
 *   - flags:      1 byte
 *   - payloadLen: 4 bytes (uint32)
 *   - payload:    payloadLen bytes
 *
 * Types:
 *   0x01 AUDIO_IN   client→server (ASR input)
 *   0x02 TEXT_OUT   server→client (ASR output)
 *   0x03 TEXT_IN    client→server (TTS input)
 *   0x04 AUDIO_OUT  server→client (TTS output)
 *   0x10 START      client→server (init)
 *   0x11 END        client→server (input done)
 *   0x20 ERROR      either direction
 *
 * Flags:
 *   0x01 final (e.g. final ASR result)
 */

// ── Type constants ───────────────────────────────────────────────────────────

export const TYPE_AUDIO_IN = 0x01;
export const TYPE_TEXT_OUT = 0x02;
export const TYPE_TEXT_IN = 0x03;
export const TYPE_AUDIO_OUT = 0x04;
export const TYPE_START = 0x10;
export const TYPE_END = 0x11;
export const TYPE_ERROR = 0x20;

// ── Flag constants ───────────────────────────────────────────────────────────

export const FLAG_FINAL = 0x01;

// ── Encoding helpers (client → server) ───────────────────────────────────────

const HEADER_SIZE = 6; // 1 + 1 + 4

function encodeFrame(type: number, flags: number, payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(HEADER_SIZE + payload.length);
	const view = new DataView(frame.buffer);
	frame[0] = type;
	frame[1] = flags;
	view.setUint32(2, payload.length, false); // big-endian
	frame.set(payload, HEADER_SIZE);
	return frame;
}

export function encodeStart(options?: { model?: string; voice?: string; language?: string }): Uint8Array {
	const payload = JSON.stringify(options ?? {});
	return encodeFrame(TYPE_START, 0x00, new TextEncoder().encode(payload));
}

export function encodeEnd(): Uint8Array {
	return encodeFrame(TYPE_END, 0x00, new Uint8Array(0));
}

export function encodeAudioIn(samples: Float32Array): Uint8Array {
	const bytes = new Uint8Array(samples.buffer);
	return encodeFrame(TYPE_AUDIO_IN, 0x00, bytes);
}

export function encodeTextIn(text: string): Uint8Array {
	return encodeFrame(TYPE_TEXT_IN, 0x00, new TextEncoder().encode(text));
}

// ── Decoding helpers (server → client) ───────────────────────────────────────

type FrameHandler = (type: number, flags: number, payload: Uint8Array) => void;

export function createFrameDecoder(handler: FrameHandler): {
	onData(data: Uint8Array): void;
} {
	const state = { buf: new Uint8Array(0) };

	return {
		onData(data: Uint8Array) {
			const next = new Uint8Array(state.buf.length + data.length);
			next.set(state.buf);
			next.set(data, state.buf.length);
			state.buf = next;

			let offset = 0;

			while (offset + HEADER_SIZE <= state.buf.length) {
				const view = new DataView(state.buf.buffer, state.buf.byteOffset + offset, HEADER_SIZE);
				const type = state.buf[offset];
				const flags = state.buf[offset + 1];
				const payloadLen = view.getUint32(2, false);

				const end = offset + HEADER_SIZE + payloadLen;
				if (end > state.buf.length) break;

				const payload = state.buf.slice(offset + HEADER_SIZE, end);
				handler(type, flags, payload);

				offset = end;
			}

			if (offset > 0 && offset < state.buf.length) {
				state.buf = state.buf.slice(offset);
			} else if (offset === state.buf.length) {
				state.buf = new Uint8Array(0);
			}
		},
	};
}

export function decodeTextOut(payload: Uint8Array): string {
	return new TextDecoder().decode(payload).trim();
}
