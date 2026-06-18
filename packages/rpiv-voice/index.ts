/**
 * rpiv-voice — Pi extension. Registers the `/voice` and `/voice-convo` commands
 * for local voice dictation, plus TTS playback and automatic spoken summaries.
 *
 * UI strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing
 * (standalone install of just this package), the dynamic-load shim no-ops
 * and the bridge's `t(key, fallback)` returns the inline English literal at
 * every call site. The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring
 * the key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTtsEngine, type TtsEngine } from "./audio/tts-engine.js";
import { notifyTtsEnd, notifyTtsStart } from "./audio/tts-playback.js";
import { registerVoiceCommand } from "./command/voice-command.js";
import {
	getAutoSpeakMaxChars,
	getSummaryPrompt,
	isAutoSpeakOnReplyEnabled,
	loadVoiceConfig,
} from "./config/voice-config.js";
import { I18N_NAMESPACE } from "./state/i18n-bridge.js";
import { isVoiceConvoActive } from "./state/voice-mode.js";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

try {
	const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-voice" });
} catch {
	// SDK absent — extension still loads with English-only UI.
}

// ── Module state ─────────────────────────────────────────────────────────────

// Per-turn: has any TTS already spoken this turn?
let turnHasSpoken = false;

// ── Summary state machine (only active in voice-convo mode) ──────────────────
//
//   idle      → normal turn finished → sendMessage(request) → requested
//   requested → model generates summary reply → capture at turn_end
//   requested → agent_end fires → speak summary → done
//   done      → next real user message (agent_start) → idle
//
// The summary request is sent via pi.sendMessage(customType, display:false)
// so it reuses the existing conversation context (and its KV-cache on local
// models).  A context-event filter prunes the request and reply from future
// LLM calls so they don't accumulate across turns.

type SummaryPhase = "idle" | "requested" | "done";
let summaryPhase: SummaryPhase = "idle";
let summaryText = "";

// True while the model is generating the summary reply.
// Gates registerAutoSpeak so it doesn't double-speak.
let isSummaryTurn = false;

// Context-cleanup guard: after a summary round-trip we prune the two
// injected messages (request + reply) in the next context event.
let pendingCleanup = false;

export default function (pi: ExtensionAPI): void {
	registerVoiceCommand(pi);
	registerAutoSpeak(pi);
	registerAgentEndSummary(pi);
	registerContextCleanup(pi);

	// Reset summary state when a new real user prompt starts.
	// The summary request itself also fires agent_start, but at that point
	// summaryPhase is "requested" (not "done") → no-op.
	pi.on("agent_start", () => {
		if (summaryPhase === "done") {
			summaryPhase = "idle";
			summaryText = "";
		}
	});
}

// ── agent_end summary (in-session, voice-convo only) ────────────────────────

const SUMMARY_CUSTOM_TYPE = "rpiv-voice-summary-request";

function registerAgentEndSummary(pi: ExtensionAPI): void {
	const config = loadVoiceConfig();
	const tts = createTtsEngine(config);

	// Capture the assistant reply while a summary turn is in flight.
	pi.on("turn_end", async (event) => {
		if (summaryPhase !== "requested") return;
		const msg = event.message as { role?: string; content?: unknown[] };
		if (msg.role !== "assistant") return;
		const text = extractPlainText(msg.content ?? []);
		if (text) summaryText = text;
	});

	pi.on("agent_end", async () => {
		if (!isVoiceConvoActive()) return;

		// Case 1 — summary reply just landed: speak it.
		if (summaryPhase === "requested") {
			summaryPhase = "done";
			isSummaryTurn = false;
			pendingCleanup = true;
			if (summaryText) {
				void speakAndWait(tts, summaryText);
			}
			summaryText = "";
			return;
		}

		// Case 2 — already summarised this turn.
		if (summaryPhase === "done") return;

		// Case 3 — normal turn: request summary.
		// Skip if auto-speak already spoke this turn.
		if (turnHasSpoken) return;

		summaryPhase = "requested";
		isSummaryTurn = true;
		pi.sendMessage(
			{
				customType: SUMMARY_CUSTOM_TYPE,
				content: getSummaryPrompt(config),
				display: false,
			},
			{ triggerTurn: true },
		);
	});
}

// ── Context cleanup — prune summary round-trip from future LLM calls ────────

/**
 * After a summary round-trip the context still holds the injected
 * summary-request message plus the model's short summary reply.
 *
 * On the next context event (first LLM call of the subsequent
 * user turn) we locate the summary-request by its customType and
 * drop it together with the assistant reply that follows.
 *
 * This keeps the long-term context window clean while the summary
 * turn itself still benefits from the existing KV-cache.
 */
function registerContextCleanup(pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		if (!pendingCleanup) return;

		const msgs = event.messages;

		// Walk backwards to find the injected summary-request message.
		let cutIdx = -1;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as { customType?: string };
			if (m.customType === SUMMARY_CUSTOM_TYPE) {
				cutIdx = i;
				break;
			}
		}

		if (cutIdx < 0) return; // not found yet — retry next context event

		pendingCleanup = false;

		// Also drop the assistant reply that directly follows the request.
		const endIdx =
			cutIdx + 1 < msgs.length && (msgs[cutIdx + 1] as { role?: string }).role === "assistant"
				? cutIdx + 2
				: cutIdx + 1;

		return {
			messages: [...msgs.slice(0, cutIdx), ...msgs.slice(endIdx)],
		};
	});
}

// ── Text extraction ──────────────────────────────────────────────────────────

function extractPlainText(content: unknown[]): string | null {
	if (!Array.isArray(content)) return null;
	let full = "";
	for (const part of content) {
		if (typeof part !== "object" || !part) continue;
		const p = part as { type?: string; text?: string };
		if (p.type === "text" && typeof p.text === "string") {
			full += p.text;
		}
	}
	return full.trim() || null;
}

// ── speakAndWait: play TTS, notify start/end, support key interrupt ──────────

/** Play TTS and wait for completion. Notifies tts-playback so voice-convo
 *  can gate its mic, and so key handlers can call stopActiveTts(). */
async function speakAndWait(tts: TtsEngine, text: string): Promise<void> {
	const session = tts.speakSession(text);
	if (!session) return;

	notifyTtsStart(session);
	try {
		await session.onEnd;
	} finally {
		notifyTtsEnd();
	}
}

// ── autoSpeakOnReply ────────────────────────────────────────────────────────

function registerAutoSpeak(pi: ExtensionAPI): void {
	const config = loadVoiceConfig();
	const tts = createTtsEngine(config);

	let turnMessageSequence: Array<{ role: string; index: number }> = [];
	let lastSequenceIndex = 0;

	pi.on("turn_start", () => {
		turnMessageSequence = [];
		turnHasSpoken = false;
	});

	pi.on("message_end", (event) => {
		const msg = event.message as { role?: string };
		if (msg.role) {
			turnMessageSequence.push({ role: msg.role, index: ++lastSequenceIndex });
		}
	});

	pi.on("message_end", async (event) => {
		const cfg = loadVoiceConfig();
		if (!isAutoSpeakOnReplyEnabled(cfg)) return;

		// During a summary turn, let registerAgentEndSummary handle TTS.
		if (isSummaryTurn) return;

		const msg = event.message as { role?: string; content?: unknown[] };
		if (msg.role !== "assistant") return;

		const text = extractPlainText(msg.content ?? []);
		if (!text) return;

		const maxChars = getAutoSpeakMaxChars(cfg);
		if (text.length > maxChars) return;
		if (text.includes("```")) return;

		await new Promise((r) => setTimeout(r, 300));

		if (turnHasSpoken) return;
		turnHasSpoken = true;

		const session = tts.speakSession(text);
		if (!session) return;

		notifyTtsStart(session);
		void session.onEnd.finally(() => notifyTtsEnd());
	});
}
