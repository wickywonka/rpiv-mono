# rpiv-voice

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-voice">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-voice/docs/cover.png" alt="rpiv-voice cover" width="50%">
    </picture>
  </a>
</div>

Talk to [Pi Agent](https://github.com/badlogic/pi-mono) instead of typing. `rpiv-voice` adds the `/voice` slash command — open the overlay, speak, hit `Enter`, and your transcript drops straight into Pi's editor. Speech-to-text runs **entirely on your machine** via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) SenseVoice-Small (int8 ONNX). No cloud, no API keys, no telemetry.

![Voice dictation overlay above the Pi editor](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-voice/docs/overlay.jpg)

## Features

- **100% on-device** — audio never leaves your laptop. No accounts, no API keys, no network calls after the first model download.
- **Optimized for Chinese + multilingual** — SenseVoice-Small provides fast, accurate transcription for Mandarin, Cantonese, English, Japanese, and Korean. Falls back to SenseVoice's built-in auto-detect when your locale isn't explicitly mapped.
- **Live transcript** — committed lines render as you finish phrases, with a dim rolling partial showing the still-active utterance in real time. What you see is what gets pasted (no waiting for a "proper" final).
- **VAD-driven chunking** — Silero voice-activity detection breaks long monologues at natural pauses, so latency stays bounded even on a 5-minute rant.
- **Settings screen built-in** — `Tab` flips to a settings panel showing your active mic, detected language, and a hallucination filter toggle. `Ctrl-S` to save, `Esc` or `Tab` to return to dictation.
- **STT hallucination filter** — strips spurious filler and repeating-token loops that the model sometimes emits on silence. Toggle off if you're dictating short single words.
- **Pause / resume** — hit `Space` to mute the mic without closing the overlay; great for stepping aside mid-thought.
- **Localized UI** — overlay, status bar, and settings render in multiple languages when [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) is installed. Falls back to English when it isn't.
- **Honest first-run UX** — the splash overlay shows download progress (percent + bytes), then `Extracting…`, `Verifying…`, `Loading engine…`, `Initializing mic…` before the dictation overlay opens. Half-loaded states never reach you.
- **Configurable cancel keybinding** — bind cancel to whatever your fingers prefer; no longer hardcoded to `Esc`.
- **Errors persisted, not swallowed** — recognition failures land in `~/.config/rpiv-voice/errors.log` so you can see why a phrase didn't transcribe.
- **STT backend label in status bar** — shows which backend is currently active (e.g. `Qwen3-ASR` or `SenseVoice (fallback)`), so you always know what's transcribing.

## Install

`rpiv-voice` is **opt-in** — it's not part of `/rpiv-setup` because the native deps (sherpa-onnx, decibri) are heavyweight. Install it directly:

```sh
pi install npm:@juicesharp/rpiv-voice
```

Then restart your Pi session.

### Optional: localized UI

Install `@juicesharp/rpiv-i18n` alongside it to flip the overlay, status bar, and settings strings to your active locale:

```sh
pi install npm:@juicesharp/rpiv-i18n
```

`/languages` switches the locale live — no restart.

## Usage

Type `/voice` in Pi's input — the overlay opens with a recording glyph, a session timer, and `Listening…`.

| Key | Action |
|---|---|
| *(speak)* | Equalizer animates; transcript fills in live as SenseVoice (or Qwen3-ASR) decodes |
| `Enter` | Close overlay, paste transcript into the Pi editor |
| `Esc` | Close overlay, paste nothing (configurable — see below) |
| `Space` | Pause / resume the mic |
| `Tab` | Flip between dictation and settings screens |
| `Ctrl-S` *(in Settings)* | Save settings to disk |

The dim trailing text after the committed transcript is the rolling partial — it's already part of what will paste, so you can hit `Enter` the moment you're done.

For continuous voice conversations (no Enter needed), type `/voice-convo` instead.

### First run

The first time you run `/voice`, the splash overlay downloads the SenseVoice-Small int8 ONNX model (~228 MB compressed) into `~/.pi/models/sense-voice/`. Subsequent runs load directly from disk in under a second. If a previous download was interrupted, the stale model directory is detected and re-downloaded automatically.

## Configuration

`rpiv-voice` works without any config file. To customize, drop a JSON file at `~/.config/rpiv-voice/voice.json`:

```json
{
  "hallucinationFilterEnabled": true,
  "ttsEnabled": true,
  "ttsProvider": "system",
  "ttsSpeed": 260,
  "autoSpeakOnReply": false,
  "autoSpeakMaxChars": 300
}
```

| Field | Default | Effect |
|---|---|---|
| `hallucinationFilterEnabled` | `true` | When `false`, keeps filler / repeating-token loops. Useful when dictating short single words that the filter might mistake for noise. |
| `ttsEnabled` | `true` | Globally enable/disable TTS. Set to `false` to silence all spoken output. |
| `ttsProvider` | `"system"` | TTS backend: `"system"` (OS default), `"local"` (e.g. Piper), or `"mlx-qwen3"` (Apple Silicon MLX 4-bit). |
| `ttsSpeed` | `260` | Speech rate. macOS: 100–400 (higher = faster). Linux (espeak-ng): comparable WPM. Windows: not exposed; system default is used. |
| `autoSpeakOnReply` | `false` | When `true`, automatically speak Pi's final short reply in each turn. Only applies to short, text-only messages up to `autoSpeakMaxChars`. |
| `autoSpeakMaxChars` | `300` | Maximum length (characters) of a reply that may be auto-spoken. |
| `localTtsBinary` | *(none)* | Path to a local TTS binary (e.g. Piper). Used when `ttsProvider: "local"`. |
| `localTtsModel` | *(none)* | Path to the local TTS model file. |
| `mlxQwen3Speaker` | `"Vivian"` | Speaker name for MLX Qwen3-TTS (requires `brew install speech`). See model card for available speakers. |
| `mlxQwen3Language` | `"chinese"` | Language hint for MLX Qwen3-TTS. |

You can also flip the hallucination filter interactively from the **Settings** screen (`Tab` from dictation, `Ctrl-S` to save). Advanced TTS settings are currently config-file only.

The microphone is the OS default input — `rpiv-voice` does not expose device selection. The bundled SenseVoice-Small model is loaded from `~/.pi/models/sense-voice/`; alternative models aren't supported today.

### Qwen3-ASR (optional high-quality backend)

When an external Qwen3-ASR service is running (e.g. via `mlx-qwen3-asr serve`), `rpiv-voice` uses it as the **primary STT backend** for higher-quality Chinese transcription, then falls back to SenseVoice-Small if it is unreachable or slow.

- No config required: if `http://localhost:8765` responds, it is used automatically.
- Tunable via environment:
  - `QWEN3_ASR_URL`: base URL (default `http://localhost:8765`)
  - `QWEN3_ASR_API_KEY`: Bearer token (default `test123`)
  - `QWEN3_ASR_MODEL`: model name (default `Qwen/Qwen3-ASR-1.7B`)
  - `QWEN3_ASR_TIMEOUT`: per-request timeout in ms (default `15000`)
- Behavior:
  - On startup: health check; if OK → use Qwen3-ASR as primary.
  - Per-request: if Qwen3-ASR fails or times out → fallback to SenseVoice-Small.
  - After 3 consecutive failures: stop trying Qwen3-ASR for that session.

This gives you best-in-class quality when the MLX service is up, and fully local offline-safe behavior when it isn't.

### Continuous voice conversation (`/voice-convo`)

For hands-free, assistant-style conversations, use `/voice-convo` instead of `/voice`:

- Opens a persistent overlay with:
  - Real-time equalizer visualization.
  - Status indicators: Listening / Transcribing / Sending / Waiting.
- Flow:
  - Listens until silence → transcribes → sends as user message → waits for Pi's reply → starts listening again.
- Exit with `Esc`.
- Useful when you want to talk through problems continuously without manually pressing Enter each time.

### Text-to-speech (TTS)

`rpiv-voice` can now speak back to you, not just listen.

- **System TTS** (default):
  - macOS: `say` (fast, native, good quality).
  - Linux: `espeak-ng`.
  - Windows: PowerShell `SpeechSynthesizer`.
- **Local TTS** (optional):
  - Configure `localTtsBinary` and `localTtsModel` (e.g. Piper) for fully offline, consistent voices.
- **Behavior**:
  - Non-blocking: TTS runs in the background; never stalls Pi or your commands.
  - Queue-based: only one TTS instance plays at a time; calls are serialized.
  - Graceful degradation: if the selected provider fails, falls back to system TTS.

### Spoken summaries

After the agent finishes all work, `rpiv-voice` automatically extracts a short spoken summary from the assistant's last reply and reads it aloud via TTS. Zero configuration, zero latency — the model's own words are reused.

- First paragraph of the reply, code blocks stripped, capped at ~200 characters.
- Works in both `/voice` and `/voice-convo` modes.

In `/voice-convo` mode, press **Space** to interrupt TTS playback at any time and keep talking.

### autoSpeakOnReply

When enabled, `rpiv-voice` will automatically read Pi's final short reply aloud as it arrives.

- Controlled via config (`autoSpeakOnReply: true`).
- Only speaks short assistant messages (up to `autoSpeakMaxChars`, default 300).
- Skips code-heavy or very long responses.
- Coordinates with spoken summaries so only one speaks per turn.

## Privacy

- **On-device STT by default.** Audio is decoded on your CPU via sherpa-onnx (SenseVoice-Small); nothing leaves the machine.
- **Optional local cloud STT (Qwen3-ASR).** If you run a local Qwen3-ASR service (e.g. via `mlx-qwen3-asr serve`), audio is sent only to that local endpoint. No external services, no vendor APIs.
- **No telemetry.** No usage events, no crash reports, no install pings. Errors are written to a local log only.
- **No API keys.** Nothing to provision, nothing to revoke.
- **Network only on first run** — to download the model. After that, `/voice` and `/voice-convo` work offline (unless you intentionally use Qwen3-ASR over a network).

## Requirements

- [Pi Agent CLI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- A working microphone reachable by [`decibri`](https://www.npmjs.com/package/decibri) (mic permission granted to your terminal on macOS)
- ~230 MB free disk under `~/.pi/models/sense-voice/`
- Network access on first run only

## Troubleshooting

- **"Microphone init failed"** on the splash — grant your terminal app microphone access (System Settings → Privacy & Security → Microphone on macOS), then re-run `/voice`.
- **Transcript looks like "Thanks for watching"** — The STT model hallucinated on near-silence; either speak louder/closer, or leave the hallucination filter on (the default).
- **`/voice` not found** — restart your Pi session after install. If it's still missing, confirm the entry exists in `~/.pi/agent/settings.json`.
- **Recognition errors** — check `~/.config/rpiv-voice/errors.log` for the underlying sherpa-onnx error.

## Related packages

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) — localizes the `/voice` overlay UI.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) — umbrella + `/rpiv-setup` for the rest of the `rpiv-*` family.
- [`mlx-qwen3-asr`](https://github.com/MLX-Qwen3-ASR/mlx-qwen3-asr) (optional) — local Qwen3-ASR server for higher-quality STT on Apple Silicon.

## License

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-voice.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-voice)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT — see [LICENSE](./LICENSE).
