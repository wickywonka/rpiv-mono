import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock TTS engine ─────────────────────────────────────────────────────────
const mockSpeakFn = vi.fn(async () => {});
const mockSpeakSessionFn = vi.fn(() => ({
	stop: vi.fn(),
	onEnd: Promise.resolve(),
}));

vi.mock("./audio/tts-engine.js", () => ({
	createTtsEngine: () => ({
		speak: mockSpeakFn,
		speakSession: mockSpeakSessionFn,
	}),
}));

// ── Mock voice config ───────────────────────────────────────────────────────
let voiceCfg: Record<string, unknown> = {};

vi.mock("./config/voice-config.js", () => ({
	loadVoiceConfig: () => voiceCfg,
	isAutoSpeakOnReplyEnabled: (cfg: any) => !!(cfg.autoSpeakOnReply ?? false),
	getAutoSpeakMaxChars: (cfg: any) => (cfg.autoSpeakMaxChars as number) ?? 300,
	getSummaryPrompt: () => "Summarize the outcome",
	isHallucinationFilterEnabled: () => true,
	isTtsEnabled: () => true,
	resolveTtsServices: () => [],
	__resetState: () => {},
}));

// ── Other mocks ─────────────────────────────────────────────────────────────
vi.mock("./command/voice-command.js", () => ({
	registerVoiceCommand: vi.fn(),
}));

vi.mock("./audio/tts-playback.js", () => ({
	notifyTtsStart: vi.fn(),
	notifyTtsEnd: vi.fn(),
	isTtsActive: () => false,
	stopActiveTts: vi.fn(),
}));

vi.mock("./audio/error-log.js", () => ({
	appendErrorLog: vi.fn(),
}));

vi.mock("./state/voice-mode.js", () => ({
	isVoiceConvoActive: () => true,
}));

vi.mock("./state/i18n-bridge.js", () => ({
	I18N_NAMESPACE: "rpiv-voice",
}));

(vi.mock as any)("@juicesharp/rpiv-i18n/loader", () => ({ registerLocalesFromDir: vi.fn() }), { virtual: true });

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadExtension() {
	vi.resetModules();
	mockSpeakFn.mockClear();
	mockSpeakSessionFn.mockClear();
	const mod = await import("./index.js");
	return mod.default as (pi: ExtensionAPI) => void;
}

function createMockPi() {
	const onHandlers: Record<string, Array<(event: unknown) => void | Promise<void>>> = {};
	const registeredTools: Array<{ name: string }> = [];

	const pi = {
		on: vi.fn((event: string, handler: (event: unknown) => void | Promise<void>) => {
			if (!onHandlers[event]) onHandlers[event] = [];
			onHandlers[event].push(handler);
		}),
		registerTool: vi.fn((def: { name: string }) => {
			registeredTools.push(def);
		}),
		registerCommand: vi.fn(),
		sendMessage: vi.fn(),
		exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
		onHandlers,
		registeredTools,
	} as any;
	return pi;
}

async function fireTurnEnd(pi: ReturnType<typeof createMockPi>, text: string) {
	const handlers = pi.onHandlers.turn_end ?? [];
	for (const h of handlers) {
		await h({ message: { role: "assistant", content: [{ type: "text", text }] } });
	}
}

async function fireAgentEnd(pi: ReturnType<typeof createMockPi>) {
	const handlers = pi.onHandlers.agent_end ?? [];
	for (const h of handlers) {
		await h({ messages: [] });
	}
}

async function fireMessageEnd(pi: ReturnType<typeof createMockPi>, text: string) {
	const handlers = pi.onHandlers.message_end ?? [];
	await Promise.all(
		handlers.map((h: (event: unknown) => void | Promise<void>) =>
			h({ message: { role: "assistant", content: [{ type: "text", text }] } }),
		),
	);
	await new Promise((r) => setTimeout(r, 500));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("extension registration", () => {
	beforeEach(async () => {
		await loadExtension();
	});

	it("does not register a speak_summary tool", async () => {
		const pi = createMockPi();
		(await loadExtension())(pi);
		expect(pi.registeredTools.length).toBe(0);
	});

	it("subscribes to turn_end and agent_end events", async () => {
		const pi = createMockPi();
		(await loadExtension())(pi);
		expect(pi.onHandlers.turn_end?.length).toBeGreaterThanOrEqual(1);
		expect(pi.onHandlers.agent_end?.length).toBeGreaterThanOrEqual(1);
	});
});

describe("agent_end summary", () => {
	beforeEach(async () => {
		voiceCfg = {};
		await loadExtension();
	});

	it("speaks a summary after agent_end when there is a captured reply", async () => {
		const pi = createMockPi();
		(await loadExtension())(pi);

		await fireTurnEnd(pi, "I've refactored the auth module. The login flow is now much simpler and all tests pass.");
		await fireAgentEnd(pi);
		await fireTurnEnd(pi, "Refactored the auth module successfully.");
		await fireAgentEnd(pi);

		expect(mockSpeakSessionFn).toHaveBeenCalled();
	});

	it("does not speak when no assistant reply was captured", async () => {
		const pi = createMockPi();
		(await loadExtension())(pi);

		await fireAgentEnd(pi);
		expect(mockSpeakSessionFn).not.toHaveBeenCalled();
	});

	it("does not speak when turnHasSpoken is already set (autoSpeakOnReply took priority)", async () => {
		voiceCfg = { autoSpeakOnReply: true };
		const pi = createMockPi();
		(await loadExtension())(pi);

		(pi.onHandlers.turn_start ?? []).forEach((h: (event: unknown) => void | Promise<void>) => {
			h({});
		});
		await fireMessageEnd(pi, "Done.");

		// autoSpeakOnReply should have called speakSession.
		const afterAutoSpeak = mockSpeakSessionFn.mock.calls.length;

		await fireTurnEnd(pi, "Some longer reply after the short one.");
		await fireAgentEnd(pi);

		// agent_end should NOT add another speakSession call.
		expect(mockSpeakSessionFn.mock.calls.length).toBe(afterAutoSpeak);
	});

	it("strips code blocks from the summary", async () => {
		const pi = createMockPi();
		(await loadExtension())(pi);

		await fireTurnEnd(pi, "Here is the fix:\n```ts\nconst x = 1;\n```\nEverything is now working correctly.");
		await fireAgentEnd(pi);
		await fireTurnEnd(pi, "Fix applied successfully.");
		await fireAgentEnd(pi);

		expect(mockSpeakSessionFn).toHaveBeenCalled();
		const text = (mockSpeakSessionFn.mock.calls as unknown[][])[0]?.[0] as string;
		expect(text).not.toContain("```");
		expect(text).not.toContain("const x = 1");
	});

	it("takes the first paragraph only", async () => {
		const pi = createMockPi();
		(await loadExtension())(pi);

		await fireTurnEnd(pi, "Deployment complete.\n\n## Details\n\n- Service A: healthy\n- Service B: healthy");
		await fireAgentEnd(pi);
		await fireTurnEnd(pi, "Deployment complete.");
		await fireAgentEnd(pi);

		expect(mockSpeakSessionFn).toHaveBeenCalled();
		const text = (mockSpeakSessionFn.mock.calls as unknown[][])[0]?.[0] as string;
		// Should only contain the first paragraph, not the heading or list.
		expect(text).toContain("Deployment complete");
		expect(text).not.toContain("Service A");
	});

	it("truncates long replies at sentence boundary", async () => {
		const pi = createMockPi();
		(await loadExtension())(pi);

		// A very long first sentence followed by a natural break.
		await fireTurnEnd(
			pi,
			"A very long opening sentence that goes on and on about the details of the implementation. " +
				"The second sentence is also quite lengthy and covers additional ground. " +
				"A third sentence wraps things up nicely with a clear conclusion.",
		);
		await fireAgentEnd(pi);
		await fireTurnEnd(pi, "Summary of long reply.");
		await fireAgentEnd(pi);

		expect(mockSpeakSessionFn).toHaveBeenCalled();
		const text = (mockSpeakSessionFn.mock.calls as unknown[][])[0]?.[0] as string;
		// Should be capped near 200 chars.
		expect(text.length).toBeLessThanOrEqual(210);
	});

	it("handles empty reply gracefully", async () => {
		const pi = createMockPi();
		(await loadExtension())(pi);

		await fireTurnEnd(pi, "");
		await fireAgentEnd(pi);

		expect(mockSpeakSessionFn).not.toHaveBeenCalled();
	});

	it("cleans markdown bold/italic from summary", async () => {
		const pi = createMockPi();
		(await loadExtension())(pi);

		await fireTurnEnd(pi, "The **authentication** module has been *completely* rewritten.");
		await fireAgentEnd(pi);
		await fireTurnEnd(pi, "Authentication module completely rewritten.");
		await fireAgentEnd(pi);

		expect(mockSpeakSessionFn).toHaveBeenCalled();
		const text = (mockSpeakSessionFn.mock.calls as unknown[][])[0]?.[0] as string;
		expect(text).not.toContain("**");
		expect(text).not.toContain("*");
		expect(text).toContain("Authentication");
		expect(text).toContain("completely");
	});
});
