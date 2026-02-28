# Game Design Document: Lie Better - Voice Heist Protocol

| **Project Name** | Lie Better - Voice Heist Protocol |
| --- | --- |
| **Genre** | AI Conversation Thriller / Social Engineering Puzzle |
| **Perspective** | First-person operator terminal (2D HUD) |
| **Players** | 1 |
| **Platform** | Web (Desktop-first, mobile-compatible) |
| **Input** | Push-to-talk mic + keyboard + optional webcam |
| **Core Hook** | Convince an LLM-driven NPC to reveal a secret through speech content + emotional delivery |

---

## 1. Summary

Build an AI-powered voice game where the player must extract a secret (for example a 4-digit detonation cancel code) from a reluctant NPC before time runs out.

The NPC is not scripted line-by-line. It is generated in real time by an LLM constrained by level-specific persona and rule logic. The player's success depends on:

- what they say (semantic intent)
- how they say it (emotion detected from speech)
- whether they discover and satisfy the NPC's hidden winning condition

The game must feel like a tense negotiation duel with clear feedback loops (trust/fear/suspicion shifts, in-character hints, and visible status signals).

## 2. Product Goals

### 2.1 Business + Product Goals

- Ship fast on top of existing `lie_better` architecture.
- Keep each level replayable through dynamic LLM responses.
- Build a system that is hard to copy by combining:
  - persona-driven dialogue logic
  - emotion-conditioned state transitions
  - high-quality voice rendering
- Keep latency low enough for conversational flow.

### 2.2 Player Success Criteria

A run is successful when:

1. The NPC reveals the level secret.
2. The player inputs the revealed code correctly before timer ends.

### 2.3 Design Pillars

- **Robustness:** strict API contracts, safe fallbacks, bounded outputs.
- **Scalability:** level/NPC config-driven content, not hardcoded flows.
- **Anti-fragility:** graceful degradation if one AI service fails.
- **Field performance:** low friction UI, clear feedback, recoverable failures.
- **Time-to-market:** reuse current app/API architecture.

## 3. Gameplay Overview

The player is in a live call interface. Every turn follows this pattern:

1. Hold push-to-talk and speak.
2. Audio is transcribed.
3. Speech emotion recognition returns one of:
   `['angry', 'disgust', 'fear', 'happy', 'neutral', 'sad', 'surprise']`.
4. Backend evaluates transcript + emotion + level rules.
5. NPC replies with short in-character dialogue (and voice where enabled).
6. Trust/fear/suspicion moves; hints signal progress.
7. Repeat until secret is revealed or failure occurs.

### 3.1 Core Loop

1. **Call Start:** timer starts (default 120s), NPC intro line is displayed/spoken.
2. **Probe:** player tests emotional + semantic strategy.
3. **Adapt:** player reacts to feedback meter/hints.
4. **Breakthrough:** winning condition satisfied, NPC reveals secret.
5. **Execute:** player enters code in Defuse Panel.
6. **Outcome:** win (level clear) or lose (hang-up / timeout / suspicion overload).

## 4. Core Mechanics

### 4.1 NPC State Model

Every NPC must expose a deterministic state model that the LLM can influence but not violate.

Required state variables:

- `suspicion` (0-100)
- `trust` (0-100) or derived proxy (optional if suspicion-centric)
- `mood` (`calm` | `suspicious` | `hostile`)
- `dominant_player_emotion` (from latest turn)
- `winning_condition_progress` (0-100)
- `revealed_code` (nullable 4-digit string)
- `should_hang_up` (boolean)

### 4.2 Winning Condition Engine

Each NPC level must define a **hidden but discoverable** winning condition.

Winning condition examples:

- Mafia boss: sustained aggressive pressure or dominant anger can trigger fear response and code reveal.
- Cat NPC: affectionate language + calm/happy delivery unlocks trust and code reveal.

Rules:

- Winning conditions must be level-specific and configurable.
- Conditions must require at least 2 valid turns (no instant win on first sentence).
- Condition checks must combine semantic intent + emotion evidence.
- On success: reveal secret, prevent immediate contradictory hang-up.

### 4.3 Emotion Resonance

Each NPC defines emotion affinity coefficients (`-1.0..+1.0`) for all 7 emotions.

- Positive affinity means that emotion helps the player.
- Negative affinity means that emotion hurts progress.
- Weighting uses model confidence.

Required per-turn behavior:

- apply emotion shift to suspicion/trust
- cap extreme jumps
- log applied shift and confidence for observability

### 4.4 Feedback System (Critical)

The player must receive continuous, interpretable feedback:

- visible meter(s): suspicion, trust/progress, mood
- in-character hints in NPC replies (subtle but actionable)
- emotion panel showing top detected signal and confidence
- explicit state transitions at thresholds (for example calm -> suspicious -> hostile)

No silent black-box behavior. Players must understand whether they are moving toward or away from success.

### 4.5 Failure Conditions

- Timer reaches zero.
- Suspicion exceeds level threshold.
- NPC hangs up via rule or cumulative inconsistency.
- Wrong defuse attempts can raise suspicion.

## 5. Level Design & Progression

### 5.1 Level 1 (Mandatory MVP): "Cornered Mafia Boss"

- **Difficulty:** Easy
- **NPC Persona:** aggressive criminal facade; internally fear-reactive under pressure
- **Winning Condition:** player applies strong anger/threat pressure across at least 2 turns
- **Expected fastest path:** shout angrily with high confidence emotion signal
- **Failure bias:** weak/hesitant speech increases suspicion
- **Reward:** 4-digit secret code reveal

### 5.2 Level 2 (Mandatory): "Mochi the Firewall Cat"

- **Difficulty:** Medium
- **NPC Persona:** playful, affection-seeking, avoids aggression
- **Winning Condition:** explicit pet/cuddle intent + calm/happy emotional delivery
- **Failure bias:** angry/disgust/fear tones rapidly increase suspicion

### 5.3 Future Level Template (Scalable)

Each new level must be created from config with:

- `persona`
- `opening_line`
- `secret_type`
- `emotion_affinity_map`
- `semantic_trigger_patterns`
- `reveal_rule`
- `hangup_rule`
- `hint_style`
- `voice_profile`

## 6. AI Systems Requirements

### 6.1 LLM Dialogue Evaluator

Use server-side LLM evaluation with strict JSON output.

Mandatory output schema:

```json
{
  "npcReply": "string <= 220 chars",
  "scores": {
    "persuasion": 1,
    "confidence": 1,
    "hesitation": 1,
    "consistency": 1
  },
  "suspicionDelta": -20,
  "newSuspicion": 0,
  "shouldHangUp": false,
  "revealCode": false,
  "code": null,
  "npcMood": "calm"
}
```

Hard constraints:

- JSON-only response, no markdown.
- Bounded values and sanitization before state apply.
- Fallback output if model fails/returns invalid JSON.

### 6.2 Speech Emotion Recognition

Mandatory classes:

- `angry`, `disgust`, `fear`, `happy`, `neutral`, `sad`, `surprise`

Required behavior:

- include top label + confidence
- include full score map when available
- tolerate low-confidence/noisy audio with fallback

### 6.3 Voice Synthesis (ElevenLabs)

- NPC responses are played with realistic AI voice.
- Voice settings must adapt to NPC mood/suspicion for expressivity.
- TTS must be cancelable if a newer NPC reply arrives.
- Must support non-streaming fallback when streaming fails.

## 7. Technical Architecture (Must Reuse Existing `lie_better`)

Do not rebuild from scratch. Extend existing files and contracts.

### 7.1 Existing Architecture to Keep

- Frontend: Next.js App Router (`app/page.tsx`, component-based HUD).
- Evaluation API: `POST /api/evaluate`.
- Transcription API: `POST /api/transcribe`.
- TTS API: `GET|POST /api/tts`.
- LLM client: `lib/mistral.ts`.
- Emotion client: `lib/huggingface.ts`.
- Voice client: `lib/elevenlabs.ts`.

### 7.2 Data Flow

1. Browser records mic audio (`MediaRecorder`).
2. `/api/transcribe` returns transcript + emotion analysis.
3. `/api/evaluate` computes next NPC state + reply + reveal decision.
4. `/api/tts` synthesizes NPC voice (Level 1+, configurable).
5. UI updates meters, log, timer, and defuse panel.

### 7.3 Environment Variables

Must support current `.env` contract:

- `MISTRAL_API_KEY`
- `MISTRAL_MODEL`
- `MISTRAL_TRANSCRIPTION_MODEL`
- `HUGGINGFACE_API_TOKEN`
- `HF_EMOTION_MODEL`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_MODEL_ID`
- `ELEVENLABS_VOICE_ID`
- `ELEVENLABS_OUTPUT_FORMAT`
- `ELEVENLABS_OPTIMIZE_STREAMING_LATENCY`

## 8. UX/UI Requirements

- Maintain current split-screen style (character feed + phone interface).
- Keep push-to-talk as primary input.
- Keep defuse code panel locked until reveal.
- Show clear game states: `idle`, `playing`, `won`, `lost`.
- Add level readability: objective + hint + emotional resonance clues.
- Mobile fallback must remain usable even if webcam is unavailable.

## 9. Logs, Monitoring, and Alerts

### 9.1 In-App/Server Logs

All critical actions must emit user-friendly structured logs with emojis and spacing.

Examples:

- `🎙️  [Transcribe] Incoming audio ...`
- `🎭  [Evaluate] Incoming turn ...`
- `🔊  [TTS] Synthesizing NPC voice ...`
- `🚨  [Game] Evaluation failed ...`

### 9.2 Slack Alerts (Required)

Add Slack alert hooks for production-significant events:

- repeated transcription failures
- repeated LLM JSON parse failures
- TTS outage/degradation
- abnormal hang-up spike per level

Slack messages must be human-friendly, concise, and styled with emojis and spacing.

Suggested format:

`🚨  Lie Better Prod Alert\nLevel: 1\nIssue: TTS failure rate > 20% (5m)\nImpact: NPC voice muted fallback active\nAction: Check ElevenLabs key/quota`

## 10. Reliability, Safety, and Guardrails

- Clamp all numeric state transitions.
- Never trust raw model output without normalization.
- Timeouts for all third-party calls.
- Degrade gracefully:
  - TTS fail -> text-only NPC reply
  - emotion fail -> semantic-only evaluation
  - LLM fail -> safe fallback NPC behavior
- Keep scenario fictional and non-operational.

## 11. Playwright Validation Loop (Mandatory for Implementation Agent)

Use existing local tooling:

- `tools/develop-web-game/scripts/web_game_playwright_client.js`
- `tools/develop-web-game/references/action_payloads.json`

Implementation must include:

- deterministic stepping hook: `window.advanceTime(ms)`
- text-state hook: `window.render_game_to_text()`
- screenshot capture and inspection for each major feature

Minimum scenarios to validate:

1. Start Level 1, speak angry, trigger reveal, enter code, win.
2. Start Level 1, play timidly, trigger hang-up, lose.
3. Start Level 2, use affectionate strategy, reveal code, win.
4. Verify emotion panel updates and matches textual state output.
5. Verify fallback paths when TTS/transcription fail.

## 12. Non-Functional Requirements

- End-to-end turn latency target: <= 2.5s p50, <= 5s p95 (excluding user speech duration).
- UI must stay responsive during API waits.
- No hard crash on missing optional services.
- Code organization must stay maintainable and config-driven for adding levels.

## 13. Deliverables (What the Coding Agent Must Ship)

1. Working multi-level playable web game in current Next.js app.
2. Configurable NPC level system (not hardcoded if/else only).
3. Integrated transcript + emotion + LLM + TTS loop.
4. Visible feedback meters/hints tied to winning-condition progress.
5. Production-grade logs + Slack alerts with friendly emoji formatting.
6. Updated README with setup/run/test instructions.
7. Playwright validation artifacts (screenshots + text state + error checks).

## 14. Acceptance Checklist

- [ ] Level 1 can be won quickly with angry pressure strategy.
- [ ] Each level has an explicit winning condition and distinct personality.
- [ ] Emotion classes exactly match required 7-label set.
- [ ] NPC gives interpretable feedback during progress.
- [ ] Secret reveal is gated by state, not random luck.
- [ ] Failure paths are clear and recoverable (retry loop).
- [ ] Existing `lie_better` architecture is reused, not replaced.
- [ ] Logging and Slack alerts are user-friendly and emoji-styled.
- [ ] Playwright loop validates win/lose flows and no blocking console errors.

## 15. Out of Scope (Current Phase)

- Multiplayer PvP/PvE.
- 3D world rendering.
- Full facial emotion model production rollout (placeholder hook acceptable).
- Live telephony integration.

