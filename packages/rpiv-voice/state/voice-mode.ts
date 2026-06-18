/**
 * voice-mode — tiny shared flag so index.ts can gate LLM-powered summaries
 * to voice-convo mode without a circular import between index.ts and
 * command/voice-command.ts.
 */

let active = false;

export function isVoiceConvoActive(): boolean {
	return active;
}

export function setVoiceConvoActive(value: boolean): void {
	active = value;
}
