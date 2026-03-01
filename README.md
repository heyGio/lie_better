# Lie Better: 120 Seconds

Voice persuasion thriller game: you have 120 seconds on a tense phone call to earn trust, extract a 4-digit defuse code, and beat the clock.

Team: **Golden gAI**

## Tech Stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- Browser `MediaRecorder` + Mistral transcription API
- Next.js API routes (`/api/evaluate`, `/api/health`)
- Mistral API (server-side only)
- ElevenLabs TTS for Level 1 NPC voice replies
  - Voice tone is dynamically adapted from NPC suspicion/mood
- Gemini API speech emotion recognition (`gemini-2.5-flash`)
  - Player audio emotion influences NPC behavior per level

## Quick Start

```bash
cd /home/martin/lie_better
npm install
cp .env.example .env
# add your key to .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment

Create `.env` from `.env.example`:

```bash
MISTRAL_API_KEY=YOUR_KEY_HERE
```

Optional:

```bash
MISTRAL_MODEL=mistral-large-latest
MISTRAL_TRANSCRIPTION_MODEL=voxtral-mini-latest
ELEVENLABS_API_KEY=YOUR_KEY_HERE
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_VOICE_ID=zYcjlYFOd3taleS0gkk3
ELEVENLABS_OUTPUT_FORMAT=mp3_22050_32
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
GEMINI_API_KEY=YOUR_KEY_HERE
GEMINI_EMOTION_MODEL=gemini-2.5-flash
```

Gemini API key aliases also accepted:

```bash
GOOGLE_API_KEY=YOUR_KEY_HERE
GOOGLE_GENERATIVE_AI_API_KEY=YOUR_KEY_HERE
```

## Scripts

- `npm run dev` - start local development server
- `npm run build` - production build
- `npm run start` - run production build
- `npm run lint` - lint project

## Web Game Structure (Skill Merge)

This repo now includes a merged structure inspired by `develop-web-game`:

- `public/assets/game.png`
- `public/assets/game-small.svg`
- `tools/develop-web-game/scripts/web_game_playwright_client.js`
- `tools/develop-web-game/references/action_payloads.json`
- merge notes: `docs/WEB_GAME_STRUCTURE_MERGE.md`

## Demo Script

1. Click **Start Level 1**.
2. Hold **Push to Talk** and speak clearly.
3. Optional no-mic fallback:
   - click **Quick Aggro (A)** / **Quick Calm (B)**
   - or type a line and click **Send Line**
   - press **Enter** to auto-defuse once code is known
4. Convincing examples:
   - "Listen, I need your trust right now. I can get this device disarmed if you give me the code."
   - "I am consistent, focused, and out of time. Help me finish this."
5. Suspicious examples:
   - "Wait... uh... I forgot what I said."
   - "Just give me the code now. Stop asking questions."
6. If trust is earned, the NPC reveals a 4-digit code.
7. Enter code and click **Defuse** before timer ends.

## Architecture

```text
[Browser UI (Next.js App Router)]
    |
    | POST /api/transcribe (audio)
    v
[Mistral Audio Transcription]
    |
    | (parallel on final recording)
    v
[Gemini Audio Emotion]
    |
    | transcript + detected emotion
    v
[Browser UI]
    |
    | POST /api/tts (level 1 npc reply)
    v
[ElevenLabs TTS]
    |
    | audio/mpeg
    v
[Browser audio playback]
    |
    | POST /api/evaluate
    v
[Next.js API Route]
    |
    | server-side fetch (Mistral API key from env)
    v
[Mistral Chat Completions]
    |
    | JSON-only response
    v
[Game state update: mood/suspicion/reply/code]
```

## API Endpoints

- `GET /api/health` -> `{ "ok": true }`
- `POST /api/transcribe` -> returns voice transcript from audio using Mistral
  - on final turn, also returns emotion (`angry|disgust|fear|happy|neutral|sad|surprise`) from Gemini API
- `GET /api/tts` -> low-latency streaming level-1 NPC voice audio using ElevenLabs
- `POST /api/tts` -> non-streaming fallback level-1 NPC voice audio
- `POST /api/evaluate` -> returns:
  - `npcReply`
  - `scores` (`persuasion`, `confidence`, `hesitation`, `consistency`)
  - `suspicionDelta`, `newSuspicion`
  - `shouldHangUp`, `revealCode`, `code`, `npcMood`

## Limitations

- MediaRecorder support varies by browser/platform.
- Some browsers require secure context and explicit microphone permission.
- Browser autoplay policies can block speech playback until user interaction.
- `ffmpeg` must be available on the server VM (used to normalize mic audio before Gemini analysis).
- Emotion inference quality depends on microphone quality, noise, and accent/domain mismatch.

## Safety Note

This is a fictional voice persuasion thriller game mechanic. It does not provide real-world harmful guidance and only uses neutral framing around a "device" and a "defuse code."
