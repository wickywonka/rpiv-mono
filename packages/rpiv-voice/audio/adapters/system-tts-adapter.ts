/**
 * system-tts-adapter — TTS adapter using platform system TTS.
 *
 * Uses:
 *   - macOS: say -r <rate>
 *   - Linux: espeak-ng -s <speed>
 *   - Windows: PowerShell SpeechSynthesizer
 *
 * Configuration (from TtsServiceConfig):
 *   url:      "system" (ignored)
 *   protocol: "system-tts"
 *   options:
 *     speed?   numeric speed (macOS say rate 100–400, or espeak-ng wpm)
 */

import { type ChildProcess, execFile } from "node:child_process";
import { Readable } from "node:stream";
import type { TtsAudioChunk, TtsClient, TtsServiceConfig, TtsStream } from "../tts-client.js";

const TTS_TIMEOUT_MS = 30_000;

function _optStr(options: Record<string, string> | undefined, key: string, fallback: string): string {
	return options?.[key]?.trim() || fallback;
}

function optInt(options: Record<string, string> | undefined, key: string, fallback: number): number {
	const raw = options?.[key]?.trim();
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

function escapePowerShellString(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

function currentPlatform(): string {
	return (globalThis as any).process?.platform ?? "darwin";
}

export function createSystemTtsClient(config: TtsServiceConfig): TtsClient {
	const speed = optInt(config.options, "speed", 260);

	function execFilePromise(file: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile(file, args, { timeout: TTS_TIMEOUT_MS }, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	function _execChildPromise(child: ChildProcess): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!child.killed) {
					try {
						child.kill();
					} catch {
						/* ignore */
					}
				}
				reject(new Error(`TTS timed out after ${TTS_TIMEOUT_MS} ms`));
			}, TTS_TIMEOUT_MS);

			child.on("exit", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`TTS exited with code ${code}`));
			});
			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
	}

	async function speak(text: string): Promise<void> {
		const platform = currentPlatform();

		if (platform === "darwin") {
			return execFilePromise("say", ["-r", String(speed), text]);
		}

		if (platform === "linux") {
			return execFilePromise("espeak-ng", ["-s", String(speed), text]);
		}

		if (platform === "win32") {
			const script =
				"$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
				"$speak.Speak(" +
				escapePowerShellString(text) +
				")";
			return execFilePromise("powershell", ["-NoProfile", "-Command", script]);
		}
	}

	const client: TtsClient = {
		createStream(): TtsStream {
			// system TTS is batch-style; streaming is emulated.
			const parts: string[] = [];
			let done = false;

			return {
				async push(text: string): Promise<void> {
					if (done) throw new Error("Stream already ended");
					parts.push(text);
				},
				async end(): Promise<void> {
					if (done) return;
					done = true;
				},
				close(): void {
					done = true;
				},
				onChunk(_cb: (chunk: TtsAudioChunk) => void): void {
					// No-op for system TTS (no raw audio access).
				},
				onEnd(_cb: () => void): void {
					// No-op.
				},
				onError(_cb: (err: Error) => void): void {
					// No-op.
				},
			};
		},

		async synthesize(text: string): Promise<Readable> {
			// system TTS plays directly; no raw audio stream.
			// Return an empty readable as a no-op sink.
			await speak(text);
			return new Readable({
				read() {
					this.push(null);
				},
			});
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			// System TTS: assume available if platform is known.
			const platform = currentPlatform();
			if (platform === "darwin" || platform === "linux" || platform === "win32") {
				return { ok: true };
			}
			return { ok: false, message: `Unsupported platform for system TTS: ${platform}` };
		},

		close(): void {
			// No persistent resources.
		},
	};

	return client;
}
