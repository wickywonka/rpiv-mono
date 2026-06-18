/**
 * tts-factory — creates a TtsClient from VoiceConfig.
 *
 * Responsibilities:
 *   - Map each ttsServices entry to a concrete adapter.
 *   - Health-check and pick primary; rest are fallbacks.
 *   - On per-request failure, fall back to the next healthy service.
 *
 * The rest of rpiv-voice never imports individual adapters.
 */

import { Readable } from "node:stream";
import { createLocalCliTtsClient } from "./adapters/local-cli-tts-adapter.js";
import { createOpenaiTtsClient } from "./adapters/openai-tts-adapter.js";
import { createSystemTtsClient } from "./adapters/system-tts-adapter.js";
import { createWsTtsClient } from "./adapters/ws-tts-adapter.js";
import { appendErrorLog } from "./error-log.js";
import type { TtsClient, TtsServiceConfig } from "./tts-client.js";

const MAX_CONSECUTIVE_FAILURES = 3;

interface Backend {
	config: TtsServiceConfig;
	client: TtsClient;
}

/**
 * Create a TtsClient from the config's ttsServices list.
 * Falls back to system TTS if the list is empty or all unhealthy.
 */
export function createTtsClientFromConfig(ttsServices: TtsServiceConfig[]): TtsClient {
	const backends: Backend[] = [];

	for (const svc of ttsServices) {
		const client = createAdapter(svc);
		backends.push({ config: svc, client });
	}

	const health: Map<number, boolean> = new Map();

	// Run async health checks (non-blocking).
	for (let i = 0; i < backends.length; i++) {
		(async () => {
			try {
				const result = await backends[i].client.healthCheck();
				health.set(i, result.ok);
				if (!result.ok && result.message) {
					appendErrorLog("tts.health", `Backend ${svcLabel(backends[i].config)} unhealthy: ${result.message}`);
				}
			} catch {
				health.set(i, false);
			}
		})();
	}

	const consecutiveFailures = new Map<number, number>();

	return {
		createStream() {
			const idx = findHealthyBackend(backends, health);
			return backends[idx].client.createStream();
		},

		async synthesize(text: string): Promise<Readable> {
			if (!text || text.trim().length === 0) {
				return new Readable({
					read() {
						this.push(null);
					},
				});
			}

			const preferredOrder = buildPreferredOrder(backends, health);

			for (const idx of preferredOrder) {
				const fails = consecutiveFailures.get(idx) ?? 0;
				if (fails >= MAX_CONSECUTIVE_FAILURES) continue;

				try {
					const stream = await backends[idx].client.synthesize(text);
					consecutiveFailures.set(idx, 0);
					return stream;
				} catch (err) {
					consecutiveFailures.set(idx, fails + 1);
					appendErrorLog(
						"tts.error",
						`Backend ${svcLabel(backends[idx].config)} failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			// All backends exhausted; return empty stream.
			return new Readable({
				read() {
					this.push(null);
				},
			});
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			for (let i = 0; i < backends.length; i++) {
				const knownHealthy = health.get(i);
				if (knownHealthy) return { ok: true };
			}
			if (backends.length > 0) {
				return await backends[0].client.healthCheck();
			}
			return { ok: false, message: "No TTS backends configured" };
		},

		close(): void {
			for (const b of backends) {
				try {
					b.client.close();
				} catch {
					/* ignore */
				}
			}
		},
	};
}

function createAdapter(svc: TtsServiceConfig): TtsClient {
	switch (svc.protocol) {
		case "ws-streaming":
			return createWsTtsClient(svc);
		case "openai-tts":
			return createOpenaiTtsClient(svc);
		case "system-tts":
			return createSystemTtsClient(svc);
		case "local-cli":
			return createLocalCliTtsClient(svc);
		default:
			// Unknown protocol: fall back to system TTS.
			return createSystemTtsClient({ ...svc, protocol: "system-tts" });
	}
}

function svcLabel(cfg: TtsServiceConfig): string {
	return `${cfg.protocol}@${cfg.url}`;
}

function findHealthyBackend(backends: Backend[], health: Map<number, boolean>): number {
	for (let i = 0; i < backends.length; i++) {
		if (health.get(i)) return i;
	}
	return 0;
}

function buildPreferredOrder(backends: Backend[], health: Map<number, boolean>): number[] {
	const order: number[] = [];
	for (let i = 0; i < backends.length; i++) {
		if (health.get(i)) order.push(i);
	}
	for (let i = 0; i < backends.length; i++) {
		if (!order.includes(i)) order.push(i);
	}
	return order;
}
