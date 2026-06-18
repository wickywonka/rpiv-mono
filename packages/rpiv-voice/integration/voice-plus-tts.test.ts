import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsEngine, TtsSession } from "../audio/tts-engine.js";

// Mock TTS: includes speak and speakSession
vi.mock("../audio/tts-engine.js", () => {
	const speak = vi.fn(async () => {});
	const session: TtsSession = {
		stop: vi.fn(),
		onEnd: Promise.resolve(),
	};
	const speakSession = vi.fn(() => session);
	const engine: TtsEngine = { speak, speakSession };
	return { createTtsEngine: () => engine, __speakMock: speak, __speakSessionMock: speakSession };
});

vi.mock("../audio/tts-playback.js", () => ({
	notifyTtsStart: vi.fn(),
	notifyTtsEnd: vi.fn(),
	isTtsActive: () => false,
	stopActiveTts: vi.fn(),
}));

// Mock voice config
const configs: Record<string, any> = { base: {} };

vi.mock("../config/voice-config.js", () => ({
	loadVoiceConfig: () => configs.base,
	isAutoSpeakOnReplyEnabled: (cfg: any) => !!(cfg.autoSpeakOnReply ?? false),
	getAutoSpeakMaxChars: (cfg: any) => (cfg.autoSpeakMaxChars as number) ?? 300,
	getSummaryPrompt: () => "Summarize the outcome",
	isHallucinationFilterEnabled: () => true,
	isTtsEnabled: () => true,
	resolveTtsServices: () => [],
	__resetState: () => {},
}));

// Mock voice command (we don't run real /voice pipeline here)
vi.mock("../command/voice-command.js", () => ({
	registerVoiceCommand: vi.fn((pi: any) => {
		if (pi && typeof pi.registerCommand === "function") {
			pi.registerCommand("voice", { description: "mocked voice command" });
		}
	}),
}));

// Mock voice mode (enable convo mode for agent_end summary tests)
vi.mock("../state/voice-mode.js", () => ({
	isVoiceConvoActive: () => true,
}));

// Mock i18n bridge
vi.mock("../state/i18n-bridge.js", () => ({
	I18N_NAMESPACE: "rpiv-voice",
	t: vi.fn((_key, fallback) => fallback),
	getActiveLocale: () => "en",
}));

(vi.mock as any)(
	"@juicesharp/rpiv-i18n/loader",
	() => ({
		registerLocalesFromDir: vi.fn(),
	}),
	{ virtual: true },
);

async function loadExtension() {
	vi.resetModules();
	const mod = await import("../index.js");
	return mod.default as (pi: ExtensionAPI) => void;
}

function createMockPi(): ExtensionAPI & {
	registeredTools: Array<any>;
	onHandlers: Record<string, Array<any>>;
} {
	const onHandlers: Record<string, Array<any>> = {};
	const registeredTools: Array<any> = [];
	const pi = {
		on: vi.fn((event: string, handler: any) => {
			if (!onHandlers[event]) onHandlers[event] = [];
			onHandlers[event].push(handler);
		}),
		registerTool: vi.fn((def: any) => {
			registeredTools.push(def);
		}),
		registerCommand: vi.fn(),
		sendMessage: vi.fn(),
		exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
		onHandlers,
		registeredTools,
	} as any as ExtensionAPI & {
		registeredTools: Array<any>;
		onHandlers: Record<string, Array<any>>;
	};
	return pi;
}

describe("voice + tts integration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		configs.base = {};
	});

	it("should register /voice and no speak_summary tool (replaced by agent_end)", async () => {
		const pi = createMockPi();
		const init = await loadExtension();
		init(pi);

		expect(pi.registerCommand).toHaveBeenCalledWith("voice", expect.any(Object));

		const toolNames = pi.registeredTools.map((t: any) => t.name);
		expect(toolNames).not.toContain("speak_summary");
	});

	it("should trigger autoSpeakOnReply on assistant message when enabled", async () => {
		configs.base = { autoSpeakOnReply: true };
		const pi = createMockPi();
		const init = await loadExtension();
		init(pi);

		const ttsMod = (await import("../audio/tts-engine.js")) as any;
		const speakSessionMock = ttsMod.__speakSessionMock as ReturnType<typeof vi.fn>;

		const handlers = pi.onHandlers.message_end ?? [];
		for (const handler of handlers) {
			await handler({ message: { role: "assistant", content: [{ type: "text", text: "Ok." }] } }, {} as any);
		}

		// autoSpeakOnReply uses speakSession (for key-interrupt support).
		expect(speakSessionMock).toHaveBeenCalled();
		const callText = speakSessionMock.mock.calls[0]?.[0];
		expect(callText).toBe("Ok.");
	});

	it("should not auto-speak when autoSpeakOnReply is disabled", async () => {
		configs.base = { autoSpeakOnReply: false };
		const pi = createMockPi();
		const init = await loadExtension();
		init(pi);

		const ttsMod = (await import("../audio/tts-engine.js")) as any;
		const speakMock = ttsMod.__speakMock as ReturnType<typeof vi.fn>;

		const handlers = pi.onHandlers.message_end ?? [];
		for (const handler of handlers) {
			await handler({ message: { role: "assistant", content: [{ type: "text", text: "Ok." }] } }, {} as any);
		}

		expect(speakMock).not.toHaveBeenCalled();
	});

	it("should speak on agent_end with captured turn_end reply", async () => {
		configs.base = { autoSpeakOnReply: false };
		const pi = createMockPi();
		const init = await loadExtension();
		init(pi);

		const ttsMod = (await import("../audio/tts-engine.js")) as any;
		const speakSessionMock = ttsMod.__speakSessionMock as ReturnType<typeof vi.fn>;

		// Fire turn_end to populate lastAssistantReply.
		const turnEndHandlers = pi.onHandlers.turn_end ?? [];
		for (const h of turnEndHandlers) {
			await h({
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Refactored the auth module. Improved error handling." }],
				},
			});
		}

		// Fire agent_end — triggers summary request.
		const agentEndHandlers = pi.onHandlers.agent_end ?? [];
		for (const h of agentEndHandlers) {
			await h({ messages: [] });
		}

		// Second round: summary reply lands, then agent_end speaks it.
		for (const h of turnEndHandlers) {
			await h({
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Refactored the auth module. Improved error handling." }],
				},
			});
		}
		for (const h of agentEndHandlers) {
			await h({ messages: [] });
		}

		// speakSession should have been called (default rule-based summary).
		expect(speakSessionMock).toHaveBeenCalled();
		const spoken = speakSessionMock.mock.calls[0][0] as string;
		expect(spoken.length).toBeGreaterThan(0);
	});
});
