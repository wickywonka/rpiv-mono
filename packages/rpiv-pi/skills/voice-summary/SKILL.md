---
name: voice-summary
description: >-
  After completing a meaningful task (refactoring, debugging, implementing,
  explaining something non-trivial), call speak_summary to briefly summarize
  what you just did in 1–3 short sentences and speak it aloud. Use this so
  the user can hear a concise summary without reading the full reply.
  Triggers on: finishing work, completing a task, wrapping up a change.
---

# Voice Summary

After you finish a meaningful task, briefly summarize what you did and speak it aloud.

## When to use

Call `speak_summary` when:

- You have just completed a non-trivial task:
  - Refactored code
  - Fixed a bug
  - Implemented a feature
  - Explained something substantive
  - Performed a review or analysis
- The user may benefit from hearing a short summary instead of reading the full reply.

Do NOT call `speak_summary` for:

- Very short status replies (e.g. "Ok.", "Done.", "Yes.").
- Pure code outputs (let the user read them).
- Internal tool calls or silent work steps.

## How it works

- `speak_summary` is provided by the `rpiv-voice` extension.
- It:
  - Looks at your last reply.
  - Generates a short natural-language summary (1–3 sentences).
  - Speaks it aloud using TTS.
- You do not write the summary yourself; the tool does it for you.
- The full written reply is still visible to the user; the spoken summary is just an audio aid.

## Example

After refactoring:

- You: (perform refactoring, explain changes in text)
- Then: call `speak_summary`
- Tool: "I refactored the auth module and improved error handling. The changes are ready for review."

After fixing a bug:

- You: (explain root cause and fix)
- Then: call `speak_summary`
- Tool: "I fixed the race condition in the login flow and added a guard to prevent duplicate requests."
