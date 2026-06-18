/**
 * model-download — fetches the SenseVoice-Small int8 ONNX model archive into
 * `~/.pi/models/sense-voice/`, extracts it, and writes a sentinel file marking
 * the install complete.
 *
 * SenseVoice-Small is a non-autoregressive, multilingual ASR model optimized
 * for Chinese (Mandarin), Cantonese, English, Japanese, and Korean. It runs
 * fully on CPU via sherpa-onnx, is faster than Whisper, and significantly more
 * accurate for Chinese speech.
 *
 * Progress is surfaced phase-by-phase (downloading → extracting → verifying).
 */

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { t } from "../state/i18n-bridge.js";

const execFileAsync = promisify(execFile);

// ── Paths ────────────────────────────────────────────────────────────────────
const MODEL_DIR_NAME = "sense-voice";
export const MODELS_DIR = join(homedir(), ".pi", "models");
export const MODEL_DIR = join(MODELS_DIR, MODEL_DIR_NAME);
export const SENTINEL_FILE = ".download-complete";

// ── Source archive ───────────────────────────────────────────────────────────
// SenseVoice-Small int8: ~228 MB model + tokens + test_wavs.
// We use the 2024-07-17 release which supports ITN (punctuation/numbers).
const MODEL_RELEASE_TAG = "asr-models";
const MODEL_ARCHIVE_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2";
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${MODEL_RELEASE_TAG}/${MODEL_ARCHIVE_NAME}`;

// ── Files we need ────────────────────────────────────────────────────────────
const MODEL_FILE = "model.int8.onnx";
const TOKENS_FILE = "tokens.txt";
const REQUIRED_FILES: readonly string[] = [MODEL_FILE, TOKENS_FILE];

// ── Tar invocation ───────────────────────────────────────────────────────────
const TAR_BIN = "tar";
// `--strip-components=1` flattens sherpa's top-level wrapper directory so the
// REQUIRED_FILES land directly inside MODEL_DIR.
const TAR_FLAGS: readonly string[] = ["-xjf"];
const TAR_STRIP_FLAG = "--strip-components=1";

// ── Status messages ──────────────────────────────────────────────────────────
// Resolved at progress-emit time (not module load) so live `/languages` flips
// take effect mid-download.
const msgDownloading = (): string => t("splash.downloading", "Downloading speech model…");
const msgExtracting = (): string => t("splash.extracting", "Extracting model files…");
const msgVerifying = (): string => t("splash.verifying", "Verifying model files…");

// ── Public API ───────────────────────────────────────────────────────────────

export interface DownloadProgress {
	phase: "downloading" | "extracting" | "verifying";
	/** 0-100 integer when total size is known. Omitted when the server didn't
	 *  send a Content-Length, or when the phase isn't byte-bounded. */
	percent?: number;
	/** Bytes received so far during the download phase (cumulative). */
	bytesReceived?: number;
	/** Total expected bytes when known via Content-Length. */
	totalBytes?: number;
	message?: string;
}
export type ProgressCallback = (progress: DownloadProgress) => void;

// Bound how often we surface byte-count updates: terminals re-flow on every
// emit and a fast network can fire chunks at >1 kHz, which would burn CPU on
// no-op renders. 200 ms feels lively without being chatty.
const PROGRESS_THROTTLE_MS = 200;

export type ModelInstallStage = "download" | "extract" | "verify";

/**
 * Tagged failure surface for `ensureModelDownloaded` — lets callers distinguish
 * "couldn't fetch the bytes" (network / HTTP) from "got the bytes but the
 * archive was bad" (tar exit, missing file). Diagnostics matter: previously
 * every stage rolled up to the same "check your internet connection" string.
 */
export class ModelInstallError extends Error {
	constructor(
		readonly stage: ModelInstallStage,
		cause: unknown,
	) {
		super(`model install failed at ${stage}`, { cause: cause as Error });
		this.name = "ModelInstallError";
	}
}

export interface ModelPaths {
	modelPath: string; // SenseVoice: single model.int8.onnx
	tokensPath: string;
}

export function isModelDownloaded(): boolean {
	return existsSync(join(MODEL_DIR, SENTINEL_FILE));
}

export function getModelPaths(): ModelPaths {
	return {
		modelPath: join(MODEL_DIR, MODEL_FILE),
		tokensPath: join(MODEL_DIR, TOKENS_FILE),
	};
}

/**
 * Re-runs the post-extraction file existence check against an "already
 * downloaded" install. The sentinel only proves the *previous* run wrote it —
 * a user (or another tool) can have removed a required `.onnx` since then,
 * which would otherwise surface as an opaque native crash inside
 * sherpa-onnx's `OfflineRecognizer` constructor. Callers should call this
 * after `isModelDownloaded()` returns true and *before* loading the engine,
 * and on failure should `removeModelInstall()` so the next launch redownloads.
 */
export function assertModelIntact(): void {
	verifyModelFiles();
}

/** Wipe the entire model directory — used to recover from any partial /
 * corrupt install state. Idempotent and silent on missing dir. */
export function removeModelInstall(): void {
	rmSync(MODEL_DIR, { recursive: true, force: true });
}

export async function ensureModelDownloaded(onProgress: ProgressCallback, signal?: AbortSignal): Promise<ModelPaths> {
	if (isModelDownloaded()) return getModelPaths();

	mkdirSync(MODEL_DIR, { recursive: true });
	const archivePath = join(MODEL_DIR, MODEL_ARCHIVE_NAME);

	// Any failure between mkdir and writeSentinel leaves a half-populated
	// directory (partial archive, partially-extracted .onnx, etc.) but no
	// sentinel — so the next run would re-enter this function and overwrite,
	// but only after wasting bandwidth. Wiping the dir on failure makes that
	// redownload start from a clean slate and prevents a hypothetical
	// race where another caller observes the partial state mid-run.
	try {
		onProgress({ phase: "downloading", message: msgDownloading() });
		try {
			let lastEmitMs = 0;
			await downloadArchive(MODEL_URL, archivePath, signal, (stats) => {
				const now = Date.now();
				const isFinal = stats.totalBytes !== undefined && stats.bytesReceived >= stats.totalBytes;
				if (!isFinal && now - lastEmitMs < PROGRESS_THROTTLE_MS) return;
				lastEmitMs = now;
				const percent =
					stats.totalBytes && stats.totalBytes > 0
						? Math.min(100, Math.floor((stats.bytesReceived / stats.totalBytes) * 100))
						: undefined;
				onProgress({
					phase: "downloading",
					message: msgDownloading(),
					percent,
					bytesReceived: stats.bytesReceived,
					totalBytes: stats.totalBytes,
				});
			});
		} catch (err) {
			throw new ModelInstallError("download", err);
		}

		onProgress({ phase: "extracting", message: msgExtracting() });
		try {
			await extractArchive(archivePath, MODEL_DIR);
			rmSync(archivePath, { force: true });
		} catch (err) {
			throw new ModelInstallError("extract", err);
		}

		onProgress({ phase: "verifying", message: msgVerifying() });
		try {
			verifyModelFiles();
		} catch (err) {
			throw new ModelInstallError("verify", err);
		}

		writeSentinel();
		return getModelPaths();
	} catch (err) {
		removeModelInstall();
		throw err;
	}
}

// ── Internals ────────────────────────────────────────────────────────────────

interface DownloadStats {
	bytesReceived: number;
	totalBytes?: number;
}

async function downloadArchive(
	url: string,
	destPath: string,
	signal: AbortSignal | undefined,
	onStats?: (stats: DownloadStats) => void,
): Promise<void> {
	const response = await fetch(url, { signal });
	if (!response.ok || !response.body) {
		throw new Error(`Model download failed: HTTP ${response.status}`);
	}

	// Servers occasionally omit `Content-Length` for chunked / proxied
	// responses; downstream we treat undefined as "unknown total" and the
	// splash falls back to a byte-counter without a percentage.
	const totalBytes = parsePositiveInt(response.headers.get("content-length"));

	let bytesReceived = 0;
	const tap = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			bytesReceived += chunk.length;
			onStats?.({ bytesReceived, totalBytes });
			cb(null, chunk);
		},
	});

	const out = createWriteStream(destPath);
	await pipeline(Readable.fromWeb(response.body as never), tap, out, { signal });
}

const DECIMAL_RADIX = 10;

function parsePositiveInt(raw: string | null | undefined): number | undefined {
	if (!raw) return undefined;
	const value = Number.parseInt(raw, DECIMAL_RADIX);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
	await execFileAsync(TAR_BIN, [...TAR_FLAGS, archivePath, "-C", destDir, TAR_STRIP_FLAG]);
}

function verifyModelFiles(): void {
	for (const name of REQUIRED_FILES) {
		if (!existsSync(join(MODEL_DIR, name))) {
			throw new Error(`Model verification failed: missing ${name}`);
		}
	}
}

function writeSentinel(): void {
	writeFileSync(join(MODEL_DIR, SENTINEL_FILE), "", "utf-8");
}
