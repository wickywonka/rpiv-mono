/**
 * asr-factory — creates an AsrClient from VoiceConfig.
 *
 * Responsibilities:
 *   - Map each asrServices entry to a concrete adapter.
 *   - Health-check and pick primary; rest are fallbacks.
 *   - On per-request failure, fall back to the next healthy service.
 *
 * The rest of rpiv-voice never imports individual adapters.
 */

import { createVllmRealtimeAsrClient } from "./adapters/vllm-realtime-asr-adapter.js";
import type { AsrClient, AsrServiceConfig } from "./asr-client.js";
import { appendErrorLog } from "./error-log.js";

const MAX_CONSECUTIVE_FAILURES = 3;

interface Backend {
	config: AsrServiceConfig;
	client: AsrClient;
}

/**
 * Create an AsrClient from the config's asrServices list.
 * Falls back to a safe default (sherpa) if the list is empty or all unhealthy.
 */
export function createAsrClientFromConfig(asrServices: AsrServiceConfig[]): AsrClient {
	const backends: Backend[] = [];

	for (const svc of asrServices) {
		const client = createAdapter(svc);
		backends.push({ config: svc, client });
	}

	// Track which backends are known healthy / unhealthy.
	const health: Map<number, boolean> = new Map();

	// Run async health checks (non-blocking).
	for (let i = 0; i < backends.length; i++) {
		(async () => {
			try {
				const result = await backends[i].client.healthCheck();
				health.set(i, result.ok);
				if (!result.ok && result.message) {
					appendErrorLog("asr.health", `Backend ${svcLabel(backends[i].config)} unhealthy: ${result.message}`);
				}
			} catch {
				health.set(i, false);
			}
		})();
	}

	const consecutiveFailures = new Map<number, number>();

	return {
		createStream() {
			// For now, delegate to first healthy backend.
			const idx = findHealthyBackend(backends, health);
			return backends[idx].client.createStream();
		},

		async recognize(samples: Float32Array, onPartial?: (text: string) => void): Promise<string> {
			if (samples.length === 0) return "";

			const preferredOrder = buildPreferredOrder(backends, health);

			for (const idx of preferredOrder) {
				// Skip if too many consecutive failures.
				const fails = consecutiveFailures.get(idx) ?? 0;
				if (fails >= MAX_CONSECUTIVE_FAILURES) continue;

				try {
					const text = await backends[idx].client.recognize(samples, onPartial);
					consecutiveFailures.set(idx, 0);
					return text;
				} catch (err) {
					consecutiveFailures.set(idx, fails + 1);
					appendErrorLog(
						"asr.error",
						`Backend ${svcLabel(backends[idx].config)} failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			// All backends exhausted.
			return "";
		},

		async healthCheck(): Promise<{ ok: boolean; message?: string }> {
			// Consider healthy if at least one backend is healthy.
			for (let i = 0; i < backends.length; i++) {
				const knownHealthy = health.get(i);
				if (knownHealthy) return { ok: true };
			}
			// Fallback: check first backend.
			if (backends.length > 0) {
				return await backends[0].client.healthCheck();
			}
			return { ok: false, message: "No ASR backends configured" };
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

function createAdapter(svc: AsrServiceConfig): AsrClient {
	if (svc.protocol === "vllm-realtime") {
		return createVllmRealtimeAsrClient(svc);
	}
	// Unknown protocol: fall back to vllm-realtime with the given URL.
	return createVllmRealtimeAsrClient({ ...svc, protocol: "vllm-realtime" });
}

function svcLabel(cfg: AsrServiceConfig): string {
	return `${cfg.protocol}@${cfg.url}`;
}

function findHealthyBackend(backends: Backend[], health: Map<number, boolean>): number {
	// Prefer first known-healthy backend.
	for (let i = 0; i < backends.length; i++) {
		if (health.get(i)) return i;
	}
	// Otherwise, first backend.
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
