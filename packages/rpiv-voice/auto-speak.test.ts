import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock TTS engine ─────────────────────────────────────────────────────────
const speakMock = vi.fn(async () => {});
const speakSessionMock = vi.fn(() => ({
	stop: vi.fn(),
	onEnd: Promise.resolve(),
}));

vi.mock("./audio/tts-engine.js", () => ({
	createTtsEngine: () => ({
		speak: speakMock,
		speakSession: speakSessionMock,
	}),
}));

vi.mock("./audio/tts-playback.js", () => ({
	notifyTtsStart: vi.fn(),
	notifyTtsEnd: vi.fn(),
	isTtsActive: () => false,
	stopActiveTts: vi.fn(),
}));

// ── Mock voice config — controlled per-test via exported ref ────────────────
let voiceConfigBase: Record<string, unknown> = {};

vi.mock("./config/voice-config.js", () => ({
	loadVoiceConfig: () => voiceConfigBase,
	isAutoSpeakOnReplyEnabled: (cfg: any) => !!(cfg.autoSpeakOnReply ?? false),
	getAutoSpeakMaxChars: (cfg: any) => (cfg.autoSpeakMaxChars as number) ?? 300,
	isHallucinationFilterEnabled: () => true,
	isTtsEnabled: () => true,
	resolveTtsServices: () => [],
	__resetState: () => {},
}));

// ── Other required mocks ────────────────────────────────────────────────────
vi.mock("./command/voice-command.js", () => ({
	registerVoiceCommand: vi.fn(),
}));

vi.mock("./audio/mic-source.js", () => ({
	createMic: vi.fn(() => Promise.reject(new Error("mock mic unavailable"))),
}));

vi.mock("./audio/barge-in.js", () => ({
	startBargeIn: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("./audio/stt-engine.js", () => ({
	createSttEngine: vi.fn(() => ({
		recognize: vi.fn().mockResolvedValue({ text: "", backend: "asr" }),
		release: vi.fn(),
	})),
}));

vi.mock("./audio/model-download.js", () => ({
	ensureModelDownloaded: vi.fn(),
	isModelDownloaded: vi.fn(() => true),
	getModelPaths: vi.fn(() => ({
		modelPath: "/mock/model.int8.onnx",
		tokensPath: "/mock/tokens.txt",
	})),
}));

vi.mock("./audio/error-log.js", () => ({
	appendErrorLog: vi.fn(),
}));

vi.mock("./state/i18n-bridge.js", () => ({
	I18N_NAMESPACE: "rpiv-voice",
}));

(vi.mock as any)("@juicesharp/rpiv-i18n/loader", () => ({ registerLocalesFromDir: vi.fn() }), { virtual: true });

// ── Import before each test so config is picked up ──────────────────────────

let initFn: (pi: ExtensionAPI) => void;

async function loadExtension() {
	const mod = await import("./index.js");
	initFn = mod.default as (pi: ExtensionAPI) => void;
}

function createMockPi(): ExtensionAPI & {
	onHandlers: Record<string, Array<(event: unknown) => void | Promise<void>>>;
} {
	const onHandlers: Record<string, Array<(event: unknown) => void | Promise<void>>> = {};
	const pi = {
		on: vi.fn((event: string, handler: (event: unknown) => void | Promise<void>) => {
			if (!onHandlers[event]) onHandlers[event] = [];
			onHandlers[event].push(handler);
		}),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		onHandlers,
	} as any;
	return pi;
}

async function triggerMessageEnd(
	pi: ExtensionAPI & {
		onHandlers: Record<string, Array<(event: unknown) => void | Promise<void>>>;
	},
	message: { role: string; content: Array<{ type: string; text: string }> },
) {
	const handlers = pi.onHandlers.message_end ?? [];
	await Promise.all(handlers.map((handler) => handler({ message })));
	// Give any internal setTimeout(300) time to fire.
	await new Promise((r) => setTimeout(r, 500));
}

describe("autoSpeakOnReply", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		speakMock.mockClear();
		voiceConfigBase = {};
		await loadExtension();
	});

	it("should not speak when autoSpeakOnReply is disabled", async () => {
		voiceConfigBase = { autoSpeakOnReply: false };
		const pi = createMockPi();
		initFn(pi);

		(pi.onHandlers.turn_start ?? []).forEach((h) => {
			h({});
		});
		await triggerMessageEnd(pi, {
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
		});

		expect(speakMock).not.toHaveBeenCalled();
	});

	it("should speak short assistant text when enabled", async () => {
		voiceConfigBase = { autoSpeakOnReply: true };
		const pi = createMockPi();
		initFn(pi);

		(pi.onHandlers.turn_start ?? []).forEach((h) => {
			h({});
		});
		await triggerMessageEnd(pi, {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
		});

		expect(speakSessionMock).toHaveBeenCalled();
		const callText = (speakSessionMock.mock.calls as unknown[][])[0]?.[0] as string | undefined;
		expect(callText).toBe("Done.");
	});

	it("should not speak long text beyond autoSpeakMaxChars", async () => {
		voiceConfigBase = { autoSpeakOnReply: true, autoSpeakMaxChars: 20 };
		const pi = createMockPi();
		initFn(pi);

		(pi.onHandlers.turn_start ?? []).forEach((h) => {
			h({});
		});
		await triggerMessageEnd(pi, {
			role: "assistant",
			content: [{ type: "text", text: "This is a very long message that exceeds the limit." }],
		});

		expect(speakMock).not.toHaveBeenCalled();
	});

	it("should not speak if content includes code block", async () => {
		voiceConfigBase = { autoSpeakOnReply: true };
		const pi = createMockPi();
		initFn(pi);

		(pi.onHandlers.turn_start ?? []).forEach((h) => {
			h({});
		});
		await triggerMessageEnd(pi, {
			role: "assistant",
			content: [{ type: "text", text: "Here is code:\n```js\nconsole.log('hi');\n```" }],
		});

		expect(speakMock).not.toHaveBeenCalled();
	});

	it("should not speak for non-assistant messages", async () => {
		voiceConfigBase = { autoSpeakOnReply: true };
		const pi = createMockPi();
		initFn(pi);

		(pi.onHandlers.turn_start ?? []).forEach((h) => {
			h({});
		});
		await triggerMessageEnd(pi, {
			role: "user",
			content: [{ type: "text", text: "Hello" }],
		});

		expect(speakMock).not.toHaveBeenCalled();
	});
});
