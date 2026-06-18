import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock asr-factory to control backend behavior.
vi.mock("./asr-factory.js", () => ({
	createAsrClientFromConfig: vi.fn(),
}));

// Mock voice-config.
vi.mock("../config/voice-config.js", () => ({
	loadVoiceConfig: vi.fn(() => ({})),
	resolveAsrServices: vi.fn((_config: any, tokensPath: string) => [
		{
			url: tokensPath,
			protocol: "local-sherpa",
		},
	]),
	__resetState: vi.fn(),
}));

const { createAsrClientFromConfig } = await import("./asr-factory.js");
const { createSttEngine } = await import("./stt-engine.js");
const mockedCreateAsrClientFromConfig = vi.mocked(createAsrClientFromConfig);

function loudSamples(count: number): Float32Array {
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i++) samples[i] = i % 2 === 0 ? 0.5 : -0.5;
	return samples;
}

let mockClient: {
	createStream: ReturnType<typeof vi.fn>;
	recognize: ReturnType<typeof vi.fn>;
	healthCheck: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
};

describe("createSttEngine", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		mockClient = {
			createStream: vi.fn(),
			recognize: vi.fn().mockResolvedValue("hello world"),
			healthCheck: vi.fn().mockResolvedValue({ ok: true }),
			close: vi.fn(),
		};

		mockedCreateAsrClientFromConfig.mockReturnValue(mockClient as any);
	});

	it("returns an engine with recognize and release methods", () => {
		const engine = createSttEngine("/models/tokens.txt");
		expect(engine).toHaveProperty("recognize");
		expect(engine).toHaveProperty("release");
		expect(typeof engine.recognize).toBe("function");
		expect(typeof engine.release).toBe("function");
	});

	it("delegates recognize to AsrClient", async () => {
		const engine = createSttEngine("/models/tokens.txt");
		const samples = loudSamples(1600);
		const result = await engine.recognize(samples, 16000);

		expect(mockClient.recognize).toHaveBeenCalledWith(samples, undefined);
		expect(result.text).toBe("hello world");
		expect(result.backend).toBe("asr");
	});

	it("returns empty text for empty samples without calling backend", async () => {
		const engine = createSttEngine("/models/tokens.txt");
		const result = await engine.recognize(new Float32Array(0), 16000);

		expect(mockClient.recognize).not.toHaveBeenCalled();
		expect(result).toEqual({ text: "", backend: "none" });
	});

	it("calls AsrClient.close on release", () => {
		const engine = createSttEngine("/models/tokens.txt");
		engine.release();
		expect(mockClient.close).toHaveBeenCalled();
	});
});
