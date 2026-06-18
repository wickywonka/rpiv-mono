import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock tts-factory so we control backend behavior.
vi.mock("./tts-factory.js", () => ({
	createTtsClientFromConfig: vi.fn(),
}));

// Mock voice-config.
vi.mock("../config/voice-config.js", () => ({
	loadVoiceConfig: vi.fn(() => ({
		ttsEnabled: true,
	})),
	isTtsEnabled: vi.fn((c: any) => c.ttsEnabled !== false),
	resolveTtsServices: vi.fn(() => []),
	__resetState: vi.fn(),
}));

// Mock error-log.
vi.mock("./error-log.js", () => ({
	appendErrorLog: vi.fn(),
}));

// Mock child_process (for system TTS and playback paths).
vi.mock("node:child_process", () => {
	const execFileMock = vi.fn(() => ({
		on: vi.fn(),
		kill: vi.fn(),
		killed: false,
	}));
	return { execFile: execFileMock };
});

const { createTtsClientFromConfig } = await import("./tts-factory.js");
const { createTtsEngine } = await import("./tts-engine.js");

const mockedCreateTtsClientFromConfig = vi.mocked(createTtsClientFromConfig);
const loadVoiceConfigMock = (await import("../config/voice-config.js")).loadVoiceConfig as ReturnType<typeof vi.fn>;

describe("createTtsEngine", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		const mockClient = {
			createStream: vi.fn(),
			synthesize: vi.fn().mockResolvedValue(
				new (require("stream").Readable)({
					read() {
						this.push(null);
					},
				}) as any,
			),
			healthCheck: vi.fn().mockResolvedValue({ ok: true }),
			close: vi.fn(),
		};

		mockedCreateTtsClientFromConfig.mockReturnValue(mockClient as any);
		loadVoiceConfigMock.mockReturnValue({ ttsEnabled: true });
	});

	it("should be defined", () => {
		const engine = createTtsEngine();
		expect(engine).toBeDefined();
	});

	it("should expose speak and speakSession", () => {
		const engine = createTtsEngine();
		expect(typeof engine.speak).toBe("function");
		expect(typeof engine.speakSession).toBe("function");
	});

	it("should call speak without throwing", async () => {
		const engine = createTtsEngine();
		await expect(engine.speak("Hello")).resolves.toBeUndefined();
	});

	it("should do nothing for empty text", async () => {
		const engine = createTtsEngine();
		await engine.speak("");
		expect(mockedCreateTtsClientFromConfig.mock.results[0].value.synthesize).not.toHaveBeenCalled();
	});

	it("should do nothing for whitespace-only text", async () => {
		const engine = createTtsEngine();
		await engine.speak("   ");
		expect(mockedCreateTtsClientFromConfig.mock.results[0].value.synthesize).not.toHaveBeenCalled();
	});
});

describe("speakSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		const mockClient = {
			createStream: vi.fn(),
			synthesize: vi.fn().mockResolvedValue(
				new (require("stream").Readable)({
					read() {
						this.push(null);
					},
				}) as any,
			),
			healthCheck: vi.fn().mockResolvedValue({ ok: true }),
			close: vi.fn(),
		};

		mockedCreateTtsClientFromConfig.mockReturnValue(mockClient as any);
		loadVoiceConfigMock.mockReturnValue({ ttsEnabled: true });
	});

	it("should return a session for valid text", () => {
		const engine = createTtsEngine();
		const session = engine.speakSession("Hello");
		expect(session).not.toBeNull();
		expect(typeof session!.stop).toBe("function");
		expect(session!.onEnd).toBeInstanceOf(Promise);
	});

	it("should return null for empty text", () => {
		const engine = createTtsEngine();
		expect(engine.speakSession("")).toBeNull();
		expect(engine.speakSession("   ")).toBeNull();
	});

	it("should return null when ttsEnabled is false", () => {
		loadVoiceConfigMock.mockReturnValue({ ttsEnabled: false });
		const engine = createTtsEngine();
		expect(engine.speakSession("Hello")).toBeNull();
	});
});

describe("TTS: ttsEnabled flag", () => {
	let mockClient: {
		createStream: ReturnType<typeof vi.fn>;
		synthesize: ReturnType<typeof vi.fn>;
		healthCheck: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();

		mockClient = {
			createStream: vi.fn(),
			synthesize: vi.fn().mockResolvedValue(
				new (require("stream").Readable)({
					read() {
						this.push(null);
					},
				}) as any,
			),
			healthCheck: vi.fn().mockResolvedValue({ ok: true }),
			close: vi.fn(),
		};

		mockedCreateTtsClientFromConfig.mockReturnValue(mockClient as any);
	});

	it("should not execute TTS when ttsEnabled is false", async () => {
		loadVoiceConfigMock.mockReturnValue({ ttsEnabled: false });
		const engine = createTtsEngine();
		await engine.speak("test");
		expect(mockClient.synthesize).not.toHaveBeenCalled();
	});
});
