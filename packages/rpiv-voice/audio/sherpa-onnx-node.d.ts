// Ambient type declarations for sherpa-onnx-node (no .d.ts shipped upstream).
// Mirrors upstream sherpa-onnx Node.js examples and C++ config structs.
// Top-level keys are camelCase; binding converts to snake_case internally.

declare module "sherpa-onnx-node" {
	export interface Samples {
		samples: Float32Array;
		sampleRate: number;
	}
	export interface Result {
		text: string;
		tokens: string[];
		timestamps: number[];
	}
	export interface Stream {
		acceptWaveform(input: Samples): void;
	}
	// Note: OfflineRecognizer has no release/destroy/free method in
	// sherpa-onnx-node@1.13.0 — the native handle is GC-managed.
	// We use the synchronous `decode` + `getResult` pair (the canonical
	// upstream example uses sync exclusively).
	export interface Recognizer {
		createStream(): Stream;
		decode(stream: Stream): void;
		getResult(stream: Stream): Result;
	}
	// SenseVoice config — matches OfflineSenseVoiceModelConfig in sherpa-onnx.
	// `language` is one of: auto, zh, en, ko, ja, yue.
	// `useItn` enables inverse text normalization (punctuation/numbers).
	export interface SenseVoiceModelConfig {
		model: string; // path to model.int8.onnx
		language?: string;
		useItn?: boolean;
	}

	export interface Config {
		featConfig: { sampleRate: number; featureDim: number };
		modelConfig: {
			senseVoice: SenseVoiceModelConfig;
			tokens: string;
			numThreads?: number;
			provider?: string;
		};
	}
	// The binding exposes both a sync constructor and an async factory.
	// The canonical examples use the sync constructor; we keep both signatures
	// here so consumers can pick.
	export interface OfflineRecognizerCtor {
		new (config: Config): Recognizer;
		createAsync(config: Config): Promise<Recognizer>;
	}
	export const OfflineRecognizer: OfflineRecognizerCtor;
}
