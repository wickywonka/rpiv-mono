/**
 * tts-playback — tiny shared module for TTS playback coordination.
 *
 * Responsibilities:
 * - Track whether TTS is currently playing (for voice-convo mic gating).
 * - Hold a reference to the active TTS session so it can be stopped
 *   by external callers (e.g. key press in voice-convo).
 *
 * Usage:
 *   - speakAndWait (index.ts) calls notifyTtsStart/End + setActiveTtsSession.
 *   - Voice-convo checks isTtsActive() before opening mic.
 *   - Key handler calls stopActiveTts() to interrupt playback.
 */

import type { TtsSession } from "./tts-engine.js";

let active = false;
let activeSession: TtsSession | null = null;

export function notifyTtsStart(session: TtsSession): void {
	active = true;
	activeSession = session;
}

export function notifyTtsEnd(): void {
	active = false;
	activeSession = null;
}

/** True while TTS audio is being played through the speakers. */
export function isTtsActive(): boolean {
	return active;
}

/**
 * Stop the currently-playing TTS session immediately.
 * Idempotent — safe to call when nothing is playing.
 */
export function stopActiveTts(): void {
	if (activeSession) {
		activeSession.stop();
		activeSession = null;
		active = false;
	}
}
