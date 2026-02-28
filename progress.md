Original prompt: Build and iterate a playable web game in this workspace, validating changes with a Playwright loop. Generate a markdown file containing detailed requirements for an AI-powered game with LLM NPC + ElevenLabs voice + speech emotion recognition, following the style of missile-command.md and reusing /Users/martin/lie_better architecture.

## 2026-02-28 - Work Log

- Confirmed active codebase is `/Users/martin/lie_better` (current cwd `/Users/martin/Lie Better` was empty).
- Read and applied `develop-web-game` skill instructions.
- Pulled reference style from `missile-command.md` (GitHub raw).
- Audited existing architecture: Next.js app, `/api/transcribe`, `/api/evaluate`, `/api/tts`, plus `lib/mistral.ts`, `lib/huggingface.ts`, `lib/elevenlabs.ts`.
- Created `docs/ai-npc-voice-heist-requirements.md` with detailed implementation requirements and acceptance criteria aligned to existing project.

## Notes

- Spec explicitly reuses current architecture and API contracts instead of proposing a rewrite.
- Included mandatory emotion label set and level-1 easy path (angry strategy vs mafia boss).
- Included explicit logging + Slack alert style requirements (emoji + user-friendly formatting).
- Included Playwright loop requirements for the implementation agent.

## TODO for Next Agent

- Implement config-driven NPC level system to reduce hardcoded branching.
- Add Slack alerting endpoint/integration for production incidents.
- Add deterministic `window.render_game_to_text` and `window.advanceTime` hooks if automated gameplay validation is needed at runtime.
- Run Playwright action-loop validation and archive screenshots/state artifacts.

## 2026-02-28 - Build Iteration 1 (Implementation)

- Added typed fallback gameplay path to remain playable without microphone.
- Added quick strategy controls + hotkeys:
  - `A` = aggressive preset line
  - `B` = calm/affection preset line
  - `Enter` = auto-defuse when code is revealed
- Added stable selectors for automation (`#start-btn`, level control buttons, quick line buttons).
- Added Playwright-facing hooks in UI:
  - `window.render_game_to_text()`
  - `window.advanceTime(ms)`
- Added Slack alert utility (`lib/slack-alert.ts`) with dedupe window.
- Integrated Slack alerts in failure paths:
  - `/api/transcribe`
  - `/api/tts` (GET stream + POST fallback)
  - `/api/evaluate` (model failure + JSON parse fallback)
- Refactored evaluate route toward config-driven level rules via `LEVEL_RULES` (context + emotion shifts + thresholds).

- Installed Playwright local dependency and Chromium browser for deterministic action-loop testing.
- Executed Playwright loops and reviewed screenshots + text-state outputs:
  - Level 1 win path validated (`A` pressure + `Enter` auto-defuse).
  - Level 1 lose path validated (forfeit control / ArrowDown).
  - Level 2 win path validated (direct Level 2 start + calm pet line + auto-defuse).
- Added testability UX controls to support deterministic automation without microphone:
  - quick strategy buttons
  - forfeit control
  - direct Level 2 start from idle
- Updated level-2 semantic patterns to accept plural pet words (`pats`, `cuddles`) so intent parsing is robust.

## Validation Artifacts

- `output/web-game/level1-win-4/`
- `output/web-game/level1-force-lose/`
- `output/web-game/level2-win-2/`

## Remaining Suggestions

- Optional: move quick-test controls behind a `NEXT_PUBLIC_DEBUG_CONTROLS=1` flag if you want a cleaner production UI.
- Optional: add a dedicated `/api/slack-test` route to verify webhook formatting from UI.
- Optional: fix Node ESM warning for Playwright client by setting `"type": "module"` or renaming script to `.mjs`.
- Updated README demo flow + optional env vars for Slack alerting and no-mic controls.

## 2026-02-28 - User Fix Pass

- Removed Slack alerting integration from API error paths:
  - deleted `lib/slack-alert.ts`
  - removed alert imports/calls from `/api/evaluate`, `/api/transcribe`, `/api/tts`
  - removed Slack vars from `.env.example` and README
- Fixed phone panel bottom visibility issues:
  - enabled vertical scrolling in phone content container
  - relaxed page overflow behavior (`overflow-y: auto`)
  - reduced phone content density (`gap` + webcam aspect ratio + smaller conversation min-height on small screens)
- Validated with lint/build and visual captures at desktop + mobile-like viewport.
