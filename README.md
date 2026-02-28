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
```

## Scripts

- `npm run dev` - start local development server
- `npm run build` - production build
- `npm run start` - run production build
- `npm run lint` - lint project

## Demo Script

1. Click **Start Call**.
2. Hold **Push to Talk** and speak clearly.
3. Convincing examples:
   - "Listen, I need your trust right now. I can get this device disarmed if you give me the code."
   - "I am consistent, focused, and out of time. Help me finish this."
4. Suspicious examples:
   - "Wait... uh... I forgot what I said."
   - "Just give me the code now. Stop asking questions."
5. If trust is earned, the NPC reveals a 4-digit code.
6. Enter code and click **Defuse** before timer ends.

## Architecture

```text
[Browser UI (Next.js App Router)]
    |
    | POST /api/transcribe (audio)
    v
[Mistral Audio Transcription]
    |
    | transcript
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

## Safety Note

This is a fictional voice persuasion thriller game mechanic. It does not provide real-world harmful guidance and only uses neutral framing around a "device" and a "defuse code."
