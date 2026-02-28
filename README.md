# Lie Better: 120 Seconds

Voice persuasion thriller game: you have 120 seconds on a tense phone call to earn trust, extract a 4-digit defuse code, and beat the clock.

Team: **Golden gAI**

## Tech Stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- Browser `MediaRecorder` + Mistral transcription API (with manual text fallback)
- Next.js API routes (`/api/evaluate`, `/api/health`)
- Mistral API (server-side only)

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
- `POST /api/evaluate` -> returns:
  - `npcReply`
  - `scores` (`persuasion`, `confidence`, `hesitation`, `consistency`)
  - `suspicionDelta`, `newSuspicion`
  - `shouldHangUp`, `revealCode`, `code`, `npcMood`

## Limitations

- MediaRecorder support varies by browser/platform.
- Some browsers require secure context and explicit microphone permission.
- Manual text input fallback is included when microphone capture/transcription is unavailable.

## Safety Note

This is a fictional voice persuasion thriller game mechanic. It does not provide real-world harmful guidance and only uses neutral framing around a "device" and a "defuse code."
