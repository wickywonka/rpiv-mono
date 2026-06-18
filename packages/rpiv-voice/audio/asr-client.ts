/**
 * asr-client — protocol-agnostic ASR abstraction for rpiv-voice.
 *
 * Contract:
 *   - Input:  audio stream (PCM float32, 16kHz mono)
 *   - Output: text (supports both streaming and batch modes)
 *
 * The caller never depends on a concrete backend (Qwen3-ASR, sherpa-onnx,
 * or any future provider).  Backends are wired via adapters at runtime.
 */

export interface AudioChunk {
	/** PCM float32 samples, 16kHz mono */
	samples: Float32Array;
}

export interface AsrResult {
	/** Partial or final text */
	text: string;
	/** Whether this is the final result for this utterance */
	final: boolean;
	/** Session ID (available on final result from vLLM Realtime API) */
	sessionId?: string;
	/** Token usage stats (available on final result from vLLM Realtime API) */
	usage?: { audioTokens: number; outputTokens: number };
}

export interface AsrStream {
	/** Push an audio chunk into the stream */
	push(chunk: AudioChunk): Promise<void>;
	/** Signal end of utterance; triggers final result */
	end(): Promise<void>;
	/** Close and release resources */
	close(): void;
	/** Subscribe to partial/final results */
	onResult(cb: (r: AsrResult) => void): void;
	/** Error handler */
	onError(cb: (err: Error) => void): void;
}

/**
 * ASR service descriptor used in config.
 * Only declares address and protocol — never backend internals.
 */
export interface AsrServiceConfig {
	/** Service endpoint (URL or local path) */
	url: string;
	/**
	 * Protocol identifier.
	 *  - "vllm-realtime"   : vLLM Realtime API (WebSocket, base64 PCM16 chunks)
	 *  - "crispasr-sse"     : CrispASR HTTP SSE streaming (stream=true)
	 *  - "ws-streaming"     : WebSocket streaming (binary frames)
	 *  - "openai-streaming" : OpenAI-compatible streaming endpoint
	 *  - "openai-file"      : OpenAI-compatible file-upload endpoint
	 *  - "local-sherpa"     : sherpa-onnx local model (url = model path)
	 */
	protocol: string;
	/** Optional hints: model, apiKey, etc. */
	options?: Record<string, string>;
}

export interface AsrClient {
	/** Create a streaming recognition session */
	createStream(): AsrStream;

	/**
	 * One-shot: send full audio, get final text.
	 * @param onPartial  Optional callback for progressive results (SSE streaming).
	 */
	recognize(samples: Float32Array, onPartial?: (text: string) => void): Promise<string>;

	/** Health check */
	healthCheck(): Promise<{ ok: boolean; message?: string }>;

	/** Release resources */
	close(): void;
}
