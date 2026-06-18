import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getAutoSpeakMaxChars,
	isAutoSpeakOnReplyEnabled,
	isTtsEnabled,
	loadVoiceConfig,
	saveVoiceConfig,
	TEST_CONFIG_PATH,
} from "./voice-config.js";

const CONFIG_PATH = TEST_CONFIG_PATH;

describe("loadVoiceConfig", () => {
	it("returns empty object when config file is missing", () => {
		expect(loadVoiceConfig()).toEqual({});
	});
	it("returns empty object when JSON is corrupted", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, "not json", "utf-8");
		expect(loadVoiceConfig()).toEqual({});
	});
	it("roundtrips hallucinationFilterEnabled", () => {
		saveVoiceConfig({ hallucinationFilterEnabled: false });
		const config = loadVoiceConfig();
		expect(config.hallucinationFilterEnabled).toBe(false);
	});
});

describe("saveVoiceConfig", () => {
	it("creates config directory if missing (parent does not exist pre-call)", () => {
		saveVoiceConfig({ hallucinationFilterEnabled: false });
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		expect(JSON.parse(raw)["rpiv-voice"].hallucinationFilterEnabled).toBe(false);
	});
});

describe("TTS configuration helpers", () => {
	it("isTtsEnabled: defaults to true when absent", () => {
		expect(isTtsEnabled({})).toBe(true);
	});

	it("isTtsEnabled: respects explicit false", () => {
		expect(isTtsEnabled({ ttsEnabled: false })).toBe(false);
	});

	it("isAutoSpeakOnReplyEnabled: defaults to false", () => {
		expect(isAutoSpeakOnReplyEnabled({})).toBe(false);
	});

	it("isAutoSpeakOnReplyEnabled: true when explicitly set", () => {
		expect(isAutoSpeakOnReplyEnabled({ autoSpeakOnReply: true })).toBe(true);
	});

	it("getAutoSpeakMaxChars: defaults to 300", () => {
		expect(getAutoSpeakMaxChars({})).toBe(300);
	});

	it("getAutoSpeakMaxChars: uses configured value", () => {
		expect(getAutoSpeakMaxChars({ autoSpeakMaxChars: 200 })).toBe(200);
	});

	it("getAutoSpeakMaxChars: invalid values fall back to 300", () => {
		expect(getAutoSpeakMaxChars({ autoSpeakMaxChars: -10 })).toBe(300);
		expect(getAutoSpeakMaxChars({ autoSpeakMaxChars: 0 })).toBe(300);
	});
});
