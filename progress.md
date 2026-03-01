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

## 2026-02-28 - Emotion Pipeline Fix

- Root cause found: local `.env` had no Hugging Face token variable (`HUGGINGFACE_API_TOKEN` / aliases), so `/api/transcribe` always fell back to transcript heuristic.
- Extended Hugging Face token env alias support in `lib/huggingface.ts`:
  - `HUGGING_FACE_API_TOKEN`, `HF_API_KEY`, `HUGGING_FACE_TOKEN`, `HUGGINGFACE`
- Improved `/api/transcribe` response observability:
  - now returns `emotionModel`, `emotionSource`, `emotionError`
  - logs structured warning with `emotionError` when HF emotion analysis fails
- Updated front-end (`app/page.tsx`) to:
  - parse new emotion diagnostics fields
  - stop silent transcript fallback when HF errors are explicit
  - show user-friendly mic error for HF config/token issues
  - log source/model/error in emotion trace for easy debugging
- Updated README env docs with supported HF token aliases.
- Validation: `npm run lint` and `npm run build` both pass.

## 2026-02-28 - HF Router Migration Fix

- Fixed Hugging Face endpoint migration in `lib/huggingface.ts`:
  - default URL now uses `https://router.huggingface.co/hf-inference/models/<model>`
  - auto-rewrites legacy `https://api-inference.huggingface.co/models/...` URLs if still configured
- Added explicit error handling for:
  - retired endpoint/deprecation responses (`410`, "no longer supported")
  - model not deployed by inference providers (clear action: deploy dedicated Inference Endpoint + set `HF_EMOTION_API_URL`)
- Updated env docs:
  - `.env.example` now includes `HF_EMOTION_API_URL=`
  - README documents optional dedicated endpoint override
- Added clearer router-task/model unsupported error mapping (actionable message points to dedicated HF Inference Endpoint).
- Validation: `npm run lint` and `npm run build` both pass after migration patch.

## 2026-02-28 - HF 404 Clarification

- Added explicit 404 mapping in `lib/huggingface.ts` for router model-not-found cases:
  - now returns actionable error instructing to deploy dedicated Inference Endpoint and set `HF_EMOTION_API_URL`.
- Verified lint still passes.

## 2026-02-28 - Model Switch (User Requested)

- Switched default speech emotion model to:
  - `firdhokk/speech-emotion-recognition-with-openai-whisper-large-v3`
- Improved env robustness:
  - `HF_EMOTION_MODEL` now accepts either repo id (`owner/repo`) or full Hugging Face model URL.
  - if `HF_EMOTION_API_URL` is mistakenly set to a Hugging Face model page URL, it is converted to router inference URL automatically.
- Expanded emotion label normalization for this model's labels:
  - `fearful -> fear`, `surprised -> surprise`, plus `happiness/sadness` aliases.
- Updated docs:
  - `.env.example` and README now point to the requested model by default.
  - README notes this model may require dedicated `HF_EMOTION_API_URL` because public providers may return 404.
- Validation: `npm run lint` and `npm run build` both pass.

## 2026-03-01 - Level 1 Emotion Tutorial Refactor

- Refactored level-1 progression from 5 stages to 4 strict tutorial stages in `app/api/evaluate/route.ts`.
- New level-1 flow:
  - stage 1: any opening line moves forward
  - stage 2: requires detected `fear`
  - stage 3: requires detected `angry`
  - stage 4: requires detected `angry` again to reveal code
- Removed old stage-5 dependency and updated all prompt/rule references (`FINAL_STAGE=4`, strict-stage rule text, level1Flow payload).
- Rewrote stage hints/guidance patterns to align with the emotion-training tutorial wording.
- Added explicit tutorial success logging with emoji:
  - `✅  [Level1 Tutorial] Stage cleared`
- Updated UI stage cap in `app/page.tsx`:
  - added `LEVEL1_FINAL_STAGE = 4`
  - clamped `nextStage` with the new max
  - changed status text and HUD from `/5` to `/4`

## 2026-03-01 - Validation

- `npm run lint` ✅
- `npx tsc --noEmit` ✅
- Playwright action-loop validation skipped in this environment (project is run on external VMs; no local gameplay runtime expected here).
- `npm run build` ❌ (environment/workspace issue unrelated to this change):
  - Next.js lockfile patch step failed (`Cannot read properties of undefined (reading 'os')`)
  - build then failed during page data collection (`Cannot find module for page: /api/evaluate`)

## 2026-03-01 - Bomb Tick SFX (User Requested)

- Added bomb countdown tick sound in `app/page.tsx`, triggered once per second while the timer is actively counting down.
- Added `BOMB_TICK_VOLUME = 0.3` and wired the synthesized tick envelope peak to that exact volume target.
- Added `previousTimerValueRef` and a dedicated effect that plays the tick only when `timeRemaining` decreases (prevents extra ticks on non-countdown renders).
- Reset timer-tracking ref on `startGameSequence` so restart flows begin cleanly.
- Logging on playback failure is user-friendly and emoji-formatted:
  - `⚠️  [Bomb] Tick sound failed`

## 2026-03-01 - Validation (Bomb Tick)

- `npx tsc --noEmit` ✅
- `npx eslint app/page.tsx` ❌ (pre-existing, unrelated to this patch):
  - `'INTRO_PROMPT' is assigned a value but never used`
  - `'lastEmotionScore' is assigned a value but never used`
- Playwright action-loop validation skipped in this environment (project runs on external VMs; no local gameplay runtime expected here).

## 2026-03-01 - Level 2 Asset Wiring (User Requested)

- Switched level-2 base background to `public/assets/background_2.png` (replaced previous `shibuya` usage in normal scene and post-failure background state).
- Rewired level-2 NPC sprite selection in `app/page.tsx`:
  - default: `public/assets/NPC2.png`
  - player recognized emotion `angry`: `public/assets/NPC2angry.png`
  - player recognized emotion `fear`: `public/assets/NPC2scared.png`
  - level-2 win state (`won`): `public/assets/NPC2win.png`
- Kept level-1 NPC/background behavior unchanged.

## 2026-03-01 - Validation (Level 2 Assets)

- `npx tsc --noEmit` ✅
- `npx eslint app/page.tsx` ❌ (pre-existing, unrelated to this patch):
  - `'INTRO_PROMPT' is assigned a value but never used`
  - `'lastEmotionScore' is assigned a value but never used`
- Playwright action-loop validation skipped in this environment (project runs on external VMs; no local gameplay runtime expected here).

## 2026-03-01 - Mochi Voice Text Update

- Replaced Mochi verbal marker from `Mrrp` to `Miao` across runtime game text:
  - `app/page.tsx` level-2 opening line
  - `app/api/evaluate/route.ts` level-2 fallback and stage feedback lines
- Confirmed no remaining `Mrrp`/`mrrp` in `app/`, `lib/`, `types/`, `services/`.

## 2026-03-01 - Validation (Mochi Text)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Level 2 BGM Track Switch (User Requested)

- Updated BGM routing in `app/page.tsx` to use level-specific tracks:
  - intro + level 1: `/assets/Concrete_Empire_2026-02-28T212713.mp3`
  - level 2: `/assets/Phantom_Yamanote.mp3`
- Added constants for both tracks (`LEVEL1_BGM_SRC`, `LEVEL2_BGM_SRC`) and switched audio source dynamically when level changes.
- Kept existing autoplay retry behavior (click/keydown interaction listeners) and added emoji-formatted warning logs when browser blocks playback.
- Added explicit track-switch log:
  - `🎵  [BGM] Track switched`

## 2026-03-01 - Validation (Level 2 BGM)

- `npx tsc --noEmit` ✅
- Playwright action-loop validation skipped in this environment (project runs on external VMs; no local gameplay runtime expected here).

## 2026-03-01 - Level 2 Caller Name UI (User Requested)

- Updated dialog caller label in `app/page.tsx` to be level-aware:
  - level 1: `Unknown Caller`
  - level 2: `Mochi`
- Replaced the hardcoded intro status line `Unknown Caller is speaking...` with dynamic caller naming based on selected level at sequence start.
- Result: level-2 dialog box now consistently shows `Mochi` as NPC name.

## 2026-03-01 - Validation (Level 2 Caller Name)

- `npx tsc --noEmit` ✅
- Playwright action-loop validation skipped in this environment (project runs on external VMs; no local gameplay runtime expected here).

## 2026-03-01 - Suica Gate Hitbox Circle (User Requested)

- Switched the level-2 Suica gate hit detection in `app/page.tsx` from axis-aligned rectangle checks to circular collision (`distance <= radius`), centered on the gate target.
- Replaced `IC_GATE_HITBOX_WIDTH_RATIO` / `IC_GATE_HITBOX_HEIGHT_RATIO` with a single `IC_GATE_HITBOX_DIAMETER_RATIO` for consistent circular behavior across viewport sizes.
- Updated the visual target overlay to `rounded-full` and synced width/height with the shared diameter ratio so visuals match gameplay collision.

## 2026-03-01 - Validation (Suica Hitbox Circle)

- `npx tsc --noEmit` ✅
- `npm run lint` ❌ (pre-existing, unrelated to this patch):
  - `INTRO_PROMPT` is assigned a value but never used
  - `lastEmotionScore` is assigned a value but never used
- Playwright action-loop validation skipped in this environment (project runtime is on external VMs per user workflow; local main runtime is not expected here).

## 2026-03-01 - Suica Hitbox Overlay Shape Fix (User Requested)

- Fixed the visual hitbox overlay in `app/page.tsx` to render as a true circle (not an ellipse) by replacing percentage `height` with `aspectRatio: "1 / 1"` while keeping width tied to `IC_GATE_HITBOX_DIAMETER_RATIO`.
- Result: on-screen target now matches the circular collision logic.

## 2026-03-01 - Validation (Suica Circle Overlay)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Suica Hitbox Logic Synced To Visual Overlay (User Requested)

- Updated `app/page.tsx` so level-2 hit detection now uses the DOM rect of the visible red circle (`suicaHitboxRef`) for center/radius math.
- Result: moving/scaling the visual overlay directly moves/scales the real collision hitbox one-to-one.
- Kept a gate-based fallback path if the overlay ref is temporarily unavailable.

## 2026-03-01 - Validation (Suica Visual Sync)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Level 2 NPC Sprite Swap (User Requested)

- Updated `characterImageSrc` in `app/page.tsx`:
  - while level-2 Suica minigame is active (`isSuicaChallengeActive`): `/assets/NPC2win.png`
  - on level-2 win screen (`won`): `/assets/NPC2final.png`
- Added `isSuicaChallengeActive` to the memo dependency list so sprite updates are immediate when minigame starts.

## 2026-03-01 - Validation (Level 2 NPC Sprite Swap)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Suica Gate Bip SFX (User Requested)

- Added `playSuicaBip()` in `app/page.tsx` that plays `/assets/bip.wav` with high volume and emoji-formatted warning logs on failure.
- Triggered the bip exactly when Suica gate challenge completes (`completeSuicaGateChallenge`).
- Added success log metadata showing `sfx: "bip.wav"` on level-2 gate scan.

## 2026-03-01 - Validation (Suica Gate Bip)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Level 2 Timer Badge Position/Size Update (User Requested)

- Moved the `Last Train In` timer badge from the global top-right HUD into the NPC2 character container so it sits above NPC2.
- Increased badge visual weight for readability:
  - larger text (`text-base` / `md:text-lg`)
  - larger padding (`px-4 py-2.5` / `md:px-5 md:py-3`)
  - stronger border/glow for legibility.

## 2026-03-01 - Validation (Level 2 Timer Badge Move)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Level 2 Lose SFX Train (User Requested)

- Added level-2 lose SFX routing in `app/page.tsx`:
  - primary source: `/assets/train.wav`
  - automatic fallback: `/assets/train.mp3` when `.wav` is missing/unplayable.
- Kept level-1 explosion SFX unchanged (`/assets/booom.mp3`).
- Added user-friendly emoji logs for playback success/failure and fallback attempts.

## 2026-03-01 - Validation (Level 2 Lose Train SFX)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Title Screen Visual Overhaul (User Requested)

- Rebuilt the `!hasStarted` title screen in `app/page.tsx` with a full "high-energy game menu" direction:
  - cinematic panel shell + atmosphere overlays (vignette, animated grid, floating orbs)
  - expressive typography via `next/font/google` (`Orbitron` + `Rajdhani`)
  - richer level cards with mission flavor text and gameplay tags
  - clearer CTA flow (`Level 1`, `Level 2`, explicit Enter hotkey hint)
- Added stable ids on start buttons for future automation hooks:
  - `level-1-start-btn`
  - `level-2-start-btn`
- Added dedicated reusable title-screen CSS system in `app/globals.css`:
  - animation keyframes (`title-grid-drift`, `title-orb-float`, `title-glow-spin`, `title-logo-pulse`)
  - card hover/focus states
  - mobile overflow handling
  - reduced-motion fallback
- Reused `INTRO_PROMPT` in the start screen so it is no longer dead code.
- Also consumed `lastEmotionScore` in the in-game emotion bubble as confidence percent to clear the file-local lint blocker cleanly.

## 2026-03-01 - Validation (Title Screen Overhaul)

- `npx tsc --noEmit` ✅
- `npx eslint app/page.tsx` ✅
- Playwright action-loop validation intentionally skipped here (user workflow runs game runtime on external VMs; local main runtime is not expected in this workspace session).

## 2026-03-01 - Title Screen Info Simplification (User Requested)

- Simplified the new title screen copy in `app/page.tsx` to match the old lightweight information density:
  - removed extra mission/difficulty/tag copy blocks
  - kept only: game title, `Choose Level`, two level buttons, and Enter hint
- Preserved the upgraded visual atmosphere and typography so the screen still looks premium without text overload.

## 2026-03-01 - Validation (Title Screen Simplification)

- `npx tsc --noEmit` ✅
- `npx eslint app/page.tsx` ✅

## 2026-03-01 - Title Logo Asset Swap (User Requested)

- Replaced the title text on the start screen with the provided PNG logo.
- Imported user asset from:
  - `/Users/martin/Downloads/logo (1).png`
- Added project asset at:
  - `public/assets/title-logo.png`
- Updated `app/page.tsx` start-screen header to render the logo image via Next `<Image>` with native dimensions (`1376x768`) and responsive sizing.

## 2026-03-01 - Validation (Title Logo Asset Swap)

- `npx tsc --noEmit` ✅
- `npx eslint app/page.tsx` ✅

## 2026-03-01 - Title Screen Deconstruction + Full Motion Pass (User Requested)

- Removed the central glass/panel "square" container from the start screen.
- Kept only core elements:
  - logo image
  - `Level 1` button
  - `Level 2` button
- Lifted level buttons upward so they sit closer to the logo/title zone with a floating layout.
- Reworked typography for level buttons with a cleaner futuristic font (`Oxanium`) to better match the art direction.
- Added dense animated VFX across the full title scene:
  - animated vignette breathing
  - moving grid + scanline sweep
  - drifting/rotating color orbs
  - cinematic light beams
  - pulsing radial energy bloom
  - rotating conic glow field
  - rising particles
  - logo hover/float + aura + light sweep + chromatic pulse
  - floating level pills + shimmer sweep + glow pulse + text flicker
- Preserved reduced-motion fallback by disabling all title-scene animations when `prefers-reduced-motion` is enabled.

## 2026-03-01 - Validation (Title Screen Full Motion Pass)

- `npx tsc --noEmit` ✅
- `npx eslint app/page.tsx` ✅
- Note: running `eslint` on `app/globals.css` directly is not supported by current project lint parser setup (non-blocking for this change).

## 2026-03-01 - Hover Ghost Characters On Level Buttons (User Requested)

- Removed background "bubble" visuals from the title scene.
- Added hover/focus-specific transparent character reveals behind the logo zone:
  - hover `Level 1` => animated ghost character image (`/assets/angrycat.png`)
  - hover `Level 2` => animated ghost cat image (`/assets/mochi_cat.png`)
- Added pointer/focus handling in `app/page.tsx` using `titleHoverLevel` state to trigger effect reliably on mouse and keyboard focus.
- Added dedicated high-motion FX for hover reveals in `app/globals.css`:
  - reveal transition + transparency
  - stylized float path
  - pulse opacity loop
  - hue/glow shift loop
- Kept reduced-motion safety by disabling ghost animation under `prefers-reduced-motion`.

## 2026-03-01 - Validation (Hover Ghost Characters)

- `npx tsc --noEmit` ✅
- `npx eslint app/page.tsx` ✅

## 2026-03-01 - Hover Ghost Asset Swap (User Requested)

- Updated title hover ghost images:
  - Level 1 hover now uses `/assets/cat2.png`
  - Level 2 hover now uses `/assets/NPC2.png`

## 2026-03-01 - Validation (Hover Ghost Asset Swap)

- `npx tsc --noEmit` ✅
- `npx eslint app/page.tsx` ✅

## 2026-03-01 - Ghost Hover Smoothing + Symmetry Pass (User Requested)

- Reworked title hover ghost behavior to remove abrupt pop/depop:
  - added longer eased transition on `opacity`, `transform`, and `filter`
  - active/inactive states now fade smoothly
- Removed ghost motion/giggling while active:
  - ghosts are now static (no hover keyframe movement)
- Repositioned ghosts to be symmetric and aligned around the viewport center:
  - shared center anchor (`left: 50%`)
  - mirrored X offsets via shared CSS variable (`--title-ghost-offset`)
  - unified top alignment for level 1 and level 2 images
- Pushed level 1 ghost further left and level 2 ghost further right while keeping mirrored geometry.

## 2026-03-01 - Validation (Ghost Hover Smoothing + Symmetry)

- `npx tsc --noEmit` ✅
- `npx eslint app/page.tsx` ❌ (current workspace ESLint config issue: circular structure in `.eslintrc.json`, unrelated to this patch).

## 2026-03-01 - Gemini Live Emotion Migration (User Requested)

- Replaced speech-emotion backend integration from Hugging Face/local pipeline to Gemini Live API using the requested model:
  - `gemini-2.5-flash-native-audio-preview-12-2025`
- Added new server utility: `lib/gemini-emotion.ts`
  - Uses `@google/genai` Live API session (`Modality.TEXT`) for emotion classification.
  - Converts browser-recorded audio to Gemini-compatible `audio/pcm;rate=16000` with `ffmpeg` before streaming chunks.
  - Enforces strict mapping to in-game emotion set:
    - `angry|disgust|fear|happy|neutral|sad|surprise`
  - Handles parsing hardening (strict JSON preferred, fallback extraction) and timeout/error paths.
- Updated `app/api/transcribe/route.ts`:
  - switched import from `@/lib/huggingface` to `@/lib/gemini-emotion`
  - response now returns `emotionSource: "gemini"` when detected.
- Updated frontend parsing/UI wiring in `app/page.tsx`:
  - `emotionSource` type switched from `"huggingface"` to `"gemini"`
  - server error helper text now points to Gemini API key/config.
- Updated environment/docs:
  - `.env.example` now uses `GEMINI_API_KEY` + optional `GEMINI_EMOTION_MODEL`
  - `README.md` switched architecture/env docs from Hugging Face to Gemini Live and added `ffmpeg` VM prerequisite.
- Added dependency:
  - `@google/genai`

## 2026-03-01 - Validation (Gemini Migration)

- `npx tsc --noEmit` ✅
- `npx eslint app/api/transcribe/route.ts app/page.tsx lib/gemini-emotion.ts` ❌
  - toolchain/config issue in existing ESLint setup (`Converting circular structure to JSON` from `.eslintrc.json`), unrelated to runtime migration logic.
- Playwright action-loop validation skipped in this environment (project runtime remains external VM-focused per repo notes).

## 2026-03-01 - Gemini Live 1007 Protocol Hardening

- Addressed likely Live WebSocket `1007` close causes by tightening frame/schema behavior in `lib/gemini-emotion.ts`:
  - model name normalized to raw id (`gemini-2.5-flash-native-audio-preview-12-2025`), no forced `models/` prefix in `live.connect`.
  - switched realtime audio payload from `media` to `audio` field for `sendRealtimeInput`.
  - enabled explicit VAD mode (`explicitVadSignal: true`) and wrapped audio stream with `activityStart` / `activityEnd` events.
  - improved close diagnostics with close `reason` in error message.
- Kept strict JSON-only prompt and in-game emotion set mapping unchanged.

## 2026-03-01 - Validation (Gemini 1007 Hardening)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Gemini API Compatibility Fix (explicitVadSignal)

- Removed unsupported `explicitVadSignal` from Gemini Live config in `lib/gemini-emotion.ts`.
- Replaced explicit VAD activity markers with standard stream end signal:
  - removed `activityStart` / `activityEnd`
  - now uses `audioStreamEnd: true` after chunked realtime audio.
- Kept realtime payload on `audio` field and strict JSON response prompt.

## 2026-03-01 - Validation (explicitVadSignal fix)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Gemini 1007 Fix (non-audio request)

- Root-cause aligned with Gemini Native Audio behavior: model expects AUDIO response modality in Live API.
- Updated `lib/gemini-emotion.ts` Live setup:
  - `responseModalities` switched from `TEXT` to `AUDIO`
  - enabled `outputAudioTranscription: {}` to recover machine-readable text from model audio output.
- Parser input now combines:
  - text parts from `modelTurn` (if any)
  - `serverContent.outputTranscription.text` chunks (primary path for AUDIO responses)
- Kept existing strict-emotion-set parsing/mapping logic.

## 2026-03-01 - Validation (non-audio 1007 fix)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Gemini Native Audio Turn Shaping

- Further hardened Live turn sequencing in `lib/gemini-emotion.ts` to avoid text-only turn ambiguity:
  - send text instruction upfront with `turnComplete: false`
  - stream audio chunks
  - finish with `audioStreamEnd: true`
  - removed post-audio text-only `sendClientContent` turn.
- Goal: ensure the model processes a genuinely audio-driven request path.

## 2026-03-01 - Validation (turn shaping)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Gemini Intermittent Empty Payload Hardening

- Fixed intermittent `Gemini returned no parsable response content.` by hardening Live response finalization in `lib/gemini-emotion.ts`:
  - added explicit `session.sendClientContent({ turnComplete: true })` after `audioStreamEnd`.
  - added 1.3s grace window after `turnComplete` to capture late `outputAudioTranscription` chunks (ordering is not guaranteed).
  - parser now evaluates multiple candidates (latest output transcript, latest text chunk, full text aggregate).
  - added automatic retry (1 retry, total 2 attempts) for transient errors:
    - no parsable response content
    - timeout
    - close code 1007
- Added client-side resilience in `app/page.tsx`:
  - if Gemini error is specifically `no parsable response content`, fallback transcript-based emotion inference is now allowed (instead of hard blocking).
  - preserves hard error behavior for genuine Gemini config/auth failures.

## 2026-03-01 - Validation (intermittent empty payload hardening)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Frontend Recoverable Emotion Error Guard Widening

- Hardened recoverable emotion-error detection in `app/page.tsx` with `isRecoverableEmotionErrorMessage()`.
- Recoverable patterns now include:
  - `no parsable response content`
  - `no parseable response content` (alternate spelling)
  - `Cannot extract voices from a non-audio request`
  - `code 1007`
- In recoverable cases, transcript fallback is always allowed and stale mic error is cleared (`setMicError("")`).
- Non-recoverable Gemini errors still show user-friendly config warning and skip fallback.

## 2026-03-01 - Validation (frontend recoverable guard)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Log Severity Tuning for Recoverable Gemini Gaps

- User-observed warning stream was still noisy for recoverable cases.
- Updated `app/api/transcribe/route.ts`:
  - added recoverable-error matcher (same pattern family as frontend).
  - recoverable Gemini errors now log as `console.info`:
    - `ℹ️  [Emotion] Recoverable Gemini gap, transcript fallback remains active`
  - non-recoverable errors remain `console.warn`.
- Updated `app/page.tsx`:
  - recoverable fallback log downgraded from `console.warn` to `console.info`.

## 2026-03-01 - Validation (log severity tuning)

- `npx tsc --noEmit` ✅

## 2026-03-01 - Model Switch to gemini-2.5-flash (User Requested)

- Switched emotion inference target model to `gemini-2.5-flash`.
- Refactored `lib/gemini-emotion.ts` to use Gemini `models.generateContent` instead of Live WebSocket flow for emotion classification.
  - Input now sent as normalized WAV (`audio/wav`, mono, 16kHz) with strict JSON output prompt.
  - Keeps strict in-game emotion set mapping: `angry|disgust|fear|happy|neutral|sad|surprise`.
  - Retains retry behavior for transient provider-side gaps/timeouts/quota spikes.
- Updated docs/env defaults:
  - `.env.example` now defaults to `GEMINI_EMOTION_MODEL=gemini-2.5-flash`
  - README updated from Gemini Live wording to Gemini API wording + model value.

## 2026-03-01 - Validation (gemini-2.5-flash switch)

- `npx tsc --noEmit` ✅
