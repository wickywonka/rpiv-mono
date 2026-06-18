/**
 * tts-client — protocol-agnostic TTS abstraction for rpiv-voice.
 *
 * Contract:
 *   - Input:  text stream
 *   - Output: audio stream (PCM/WAV)
 *
 * The caller never depends on a concrete backend (OpenAI-TTS, system TTS,
 * Piper, MLX, or any future provider).  Backends are wired via adapters.
 */

import type { Readable } from "node:stream";

export interface TtsAudioChunk {
	/** Raw PCM bytes (16-bit LE, 16kHz mono, or provider-native) */
	data: Uint8Array;
}

export interface TtsStream {
	/** Push a text segment */
	push(text: string): Promise<void>;
	/** Signal end of input */
	end(): Promise<void>;
	/** Close and release resources */
	close(): void;
	/** Subscribe to audio chunks */
	onChunk(cb: (chunk: TtsAudioChunk) => void): void;
	/** Subscribe to end of stream */
	onEnd(cb: () => void): void;
	/** Error handler */
	onError(cb: (err: Error) => void): void;
}

/**
 * TTS service descriptor used in config.
 * Only declares address and protocol — never backend internals.
 */
export interface TtsServiceConfig {
	/** Service endpoint (URL or special keyword like "system") */
	url: string;
	/**
	 * Protocol identifier.
	 *  - "ws-streaming" : WebSocket streaming (binary frames)
	 *  - "openai-tts"   : OpenAI-compatible TTS endpoint
	 *  - "system-tts"   : platform system TTS (say / espeak-ng / SAPI)
	 *  - "local-cli"    : CLI-based TTS (e.g. Piper)
	 */
	protocol: string;
	/** Optional hints: voice, speed, language */
	options?: Record<string, string>;
}

export interface TtsClient {
	/** Create a streaming TTS session */
	createStream(): TtsStream;

	/** One-shot: text → audio (Readable stream of PCM/WAV) */
	synthesize(text: string): Promise<Readable>;

	/** Health check */
	healthCheck(): Promise<{ ok: boolean; message?: string }>;

	/** Release resources */
	close(): void;
}
