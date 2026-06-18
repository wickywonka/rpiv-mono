/**
 * tts-engine — thin wrapper over TtsClient for rpiv-voice.
 *
 * Responsibilities:
 *   - Wire config → TtsClient via tts-factory.
 *   - Execute TTS without blocking Pi.
 *   - Play PCM/WAV data via platform-native player.
 *   - On error: log to errors.log, never throw.
 *   - Provide an interruptible session (speakSession) for barge-in.
 *
 * No direct dependency on specific backends (OpenAI-TTS, system TTS, Piper, MLX).
 */

import { type ChildProcess, execFile } from "node:child_process";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTtsEnabled, loadVoiceConfig, resolveTtsServices } from "../config/voice-config.js";
import { appendErrorLog } from "./error-log.js";
import type { TtsClient } from "./tts-client.js";
import { createTtsClientFromConfig } from "./tts-factory.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface TtsOptions {
	/** ISO 639-1 language hint (e.g. "en", "zh"). Optional. */
	language?: string;
}

export interface TtsSession {
	/**
	 * Stop playback early (used by barge-in).
	 * Idempotent: safe to call multiple times.
	 */
	stop(): void;

	/**
	 * Resolved when playback finishes (either naturally or via stop).
	 */
	onEnd: Promise<void>;
}

export interface TtsEngine {
	/**
	 * Original fire-and-forget speak.
	 */
	speak(text: string, options?: TtsOptions): Promise<void>;

	/**
	 * Speak with an interruptible session (for barge-in).
	 * Returns null if TTS is disabled or text is empty.
	 */
	speakSession(text: string, options?: TtsOptions): TtsSession | null;
}

// ── Queue helpers (ensure only one TTS plays at a time) ─────────────────────

type QueueItem = () => Promise<void>;

function createQueue(): { enqueue: (task: QueueItem) => Promise<void> } {
	let running = false;
	const queue: QueueItem[] = [];

	const runNext = async () => {
		if (running) return;
		running = true;
		try {
			while (queue.length > 0) {
				const task = queue.shift()!;
				try {
					await task();
				} catch {
					// Individual task errors are handled internally.
				}
			}
		} finally {
			running = false;
		}
	};

	return {
		enqueue(task: QueueItem) {
			queue.push(task);
			void runNext();
			return Promise.resolve();
		},
	};
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createTtsEngine(_configOrPath?: unknown): TtsEngine {
	const config = loadVoiceConfig();
	const enabled = isTtsEnabled(config);
	const services = resolveTtsServices(config);
	const client: TtsClient = createTtsClientFromConfig(services);
	const queue = createQueue();

	return {
		async speak(text: string, _options?: TtsOptions): Promise<void> {
			if (!enabled || !text || text.trim().length === 0) return;

			const trimmed = text.trim();

			queue.enqueue(async () => {
				try {
					await synthesizeAndPlay(client, trimmed);
				} catch (err) {
					appendErrorLog("tts.error", err);
				}
			});
		},

		speakSession(text: string, _options?: TtsOptions): TtsSession | null {
			if (!enabled || !text || text.trim().length === 0) return null;

			const trimmed = text.trim();
			return startInterruptibleTtsQueued(client, trimmed, queue);
		},
	};
}

// ── Platform helpers ─────────────────────────────────────────────────────────

function platform(): string {
	return (globalThis as any).process?.platform ?? "darwin";
}

function execFilePromise(file: string, args: string[], timeoutMs = 30_000): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: timeoutMs }, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function execFileChild(file: string, args: string[]): ChildProcess {
	return execFile(file, args);
}

/**
 * Write raw PCM (int16 LE, 24kHz mono) to a WAV file.
 * Returns the temp file path.
 */
function pcmToTempWav(pcmData: Buffer): string {
	const sampleRate = 24000; // CrispASR/openai-tts default
	const numChannels = 1;
	const bitsPerSample = 16;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);
	const dataSize = pcmData.length;
	const fileSize = 44 + dataSize;

	const dir = mkdtempSync(join(tmpdir(), "rpiv-tts-"));
	const path = join(dir, "tts.wav");

	const buf = Buffer.alloc(fileSize);
	let offset = 0;

	// RIFF header
	writeString(buf, offset, "RIFF");
	offset += 4;
	writeUint32LE(buf, offset, fileSize - 8);
	offset += 4;
	writeString(buf, offset, "WAVE");
	offset += 4;

	// fmt chunk
	writeString(buf, offset, "fmt ");
	offset += 4;
	writeUint32LE(buf, offset, 16);
	offset += 4; // chunk size
	writeUint16LE(buf, offset, 1);
	offset += 2; // PCM
	writeUint16LE(buf, offset, numChannels);
	offset += 2;
	writeUint32LE(buf, offset, sampleRate);
	offset += 4;
	writeUint32LE(buf, offset, byteRate);
	offset += 4;
	writeUint16LE(buf, offset, blockAlign);
	offset += 2;
	writeUint16LE(buf, offset, bitsPerSample);
	offset += 2;

	// data chunk
	writeString(buf, offset, "data");
	offset += 4;
	writeUint32LE(buf, offset, dataSize);
	offset += 4;
	pcmData.copy(buf, offset);

	writeFileSync(path, buf);
	return path;
}

function writeString(buf: Buffer, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
}

function writeUint32LE(buf: Buffer, offset: number, value: number): void {
	buf.writeUInt32LE(value, offset);
}

function writeUint16LE(buf: Buffer, offset: number, value: number): void {
	buf.writeUInt16LE(value, offset);
}

/**
 * Play a WAV file via platform-native player.
 * Returns a promise that resolves when playback finishes.
 */
async function playWav(path: string): Promise<void> {
	const plat = platform();

	if (plat === "darwin") {
		return execFilePromise("afplay", [path]);
	}
	if (plat === "linux") {
		return execFilePromise("aplay", [path]);
	}
	if (plat === "win32") {
		const script = `(New-Object Media.SoundPlayer '${path.replace(/'/g, "''")}').PlaySync()`;
		return execFilePromise("powershell", ["-NoProfile", "-Command", script]);
	}
}

/**
 * Play a WAV file, exposing the player process for barge-in.
 */
function playWavChild(path: string): ChildProcess {
	const plat = platform();

	if (plat === "darwin") {
		return execFileChild("afplay", [path]);
	}
	if (plat === "linux") {
		return execFileChild("aplay", [path]);
	}
	if (plat === "win32") {
		const script = `(New-Object Media.SoundPlayer '${path.replace(/'/g, "''")}').PlaySync()`;
		return execFileChild("powershell", ["-NoProfile", "-Command", script]);
	}
	throw new Error("Unsupported platform for wav playback");
}

// ── Synthesize + play ────────────────────────────────────────────────────────

/**
 * Fetch PCM from TTS backend, wrap in WAV, play it, clean up.
 */
async function synthesizeAndPlay(client: TtsClient, text: string): Promise<void> {
	const stream = await client.synthesize(text);
	const chunks: Buffer[] = [];

	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			chunks.push(chunk);
		}
	} catch {
		// drain error
	}

	if (chunks.length === 0) return;

	const pcm = Buffer.concat(chunks);
	const wavPath = pcmToTempWav(pcm);

	try {
		await playWav(wavPath);
	} finally {
		try {
			unlinkSync(wavPath);
		} catch {
			/* ignore */
		}
	}
}

// ── Interruptible TTS session (queued) ──────────────────────────────────────

function startInterruptibleTtsQueued(
	client: TtsClient,
	text: string,
	queue: { enqueue: (task: () => Promise<void>) => Promise<void> },
): TtsSession {
	let stoppedExternally = false;
	let child: ChildProcess | null = null;

	const onEnd = new Promise<void>((resolve) => {
		const done = () => {
			if (stoppedExternally) return;
			stoppedExternally = true;
			resolve();
		};

		queue.enqueue(async () => {
			if (stoppedExternally) {
				resolve();
				return;
			}

			try {
				const stream = await client.synthesize(text);
				const chunks: Buffer[] = [];

				for await (const chunk of stream as AsyncIterable<Buffer>) {
					if (stoppedExternally) break;
					chunks.push(chunk);
				}

				if (!stoppedExternally && chunks.length > 0) {
					const pcm = Buffer.concat(chunks);
					const wavPath = pcmToTempWav(pcm);

					try {
						if (!stoppedExternally) {
							child = playWavChild(wavPath);
							await childPromise(child);
						}
					} finally {
						try {
							unlinkSync(wavPath);
						} catch {
							/* ignore */
						}
					}
				}
			} catch {
				// handled
			} finally {
				done();
			}
		});
	});

	return {
		stop(): void {
			if (stoppedExternally) return;
			stoppedExternally = true;
			if (child && !child.killed) {
				try {
					child.kill();
				} catch {
					// ignore
				}
			}
		},
		onEnd,
	};
}

function childPromise(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			if (!child.killed) {
				try {
					child.kill();
				} catch {
					/* ignore */
				}
			}
			reject(new Error("TTS playback timed out"));
		}, 60_000);

		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`TTS player exited with code ${code}`));
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
