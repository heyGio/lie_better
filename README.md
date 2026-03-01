# Lie Better: 120 Seconds

Lie Better: 120 Seconds is a voice-driven persuasion game built with Next.js. You are dropped into a 120-second conversation, judged on what you say and how you sound, and forced to earn trust before the clock runs out.

The current build includes two playable scenarios:

- Level 1: a hostile caller who only cracks if you perform the required emotional beats.
- Level 2: Mochi, a mischievous cat in Shibuya who stole your Suica card and reacts to warmth, sadness, and player intent.

## Why This Project Exists

This repo experiments with a simple game loop powered by three signals at once:

- speech-to-text from the player's microphone
- speech emotion classification from the player's voice
- LLM-based NPC state updates and replies

Instead of treating voice as a text input shortcut, the game makes delivery matter. Emotion affects suspicion, stage progression, and whether the NPC helps or shuts you down.

## Gameplay Loop

1. Start a level and listen to the NPC opening line.
2. Hold Push to Talk and speak your response.
3. The app transcribes your audio, classifies emotion, and evaluates your line.
4. The NPC reply updates the scene, suspicion meter, and stage progression.
5. If you earn the reveal, enter the code or complete the level objective before time expires.

There is also a no-mic fallback for testing and demos through typed input and quick-response buttons.

## Visuals

### Title / Call Screen

![Title screen](output/web-game/visual/shot-0.png)

### Level 1

![Level 1 gameplay](output/web-game/visual/level-1.png)

### Level 2

![Level 2 gameplay](output/web-game/visual/level-2.png)

## Features

- Real-time voice interaction with browser `MediaRecorder`
- Mistral-powered transcription and NPC evaluation
- Local speech emotion recognition via FastAPI
- ElevenLabs NPC voice playback for both levels
- Suspicion meter, stage-based progression, and fail states
- Keyboard-friendly fallback flow for testing without a microphone
- Playwright artifacts and captured screenshots in `output/web-game/`

## Stack

- Next.js 16 App Router
- React 18
- TypeScript
- Tailwind CSS
- Mistral API for transcription and evaluation
- ElevenLabs API for NPC voice synthesis
- Local FastAPI emotion service using `3loi/SER-Odyssey-Baseline-WavLM-Categorical`

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Then open `http://localhost:3000`.

## Environment Variables

Required:

```bash
MISTRAL_API_KEY=YOUR_KEY_HERE
ELEVENLABS_API_KEY=YOUR_KEY_HERE
```

Common defaults:

```bash
MISTRAL_MODEL=mistral-large-latest
MISTRAL_TRANSCRIPTION_MODEL=voxtral-mini-latest
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_VOICE_ID=zYcjlYFOd3taleS0gkk3
ELEVENLABS_VOICE_ID_LEVEL_2=ocZQ262SsZb9RIxcQBOj
ELEVENLABS_OUTPUT_FORMAT=mp3_22050_32
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
EMOTION_LOCAL_URL=http://127.0.0.1:5050
EMOTION_MODEL=3loi/SER-Odyssey-Baseline-WavLM-Categorical
NEXT_PUBLIC_SUICA_MINIGAME_TEST_SKIP=1
```

## Run The Emotion Service

Start the local FastAPI service in a separate terminal:

```bash
cd services/emotion
pip install -r requirements.txt
python serve.py --host 0.0.0.0 --port 5050
```

The web app can run without emotion classification, but the intended gameplay depends on that service being available.

## API Surface

- `GET /api/health` health check
- `POST /api/transcribe` audio upload, transcription, optional emotion analysis
- `GET /api/tts` low-latency streamed NPC voice
- `POST /api/tts` buffered NPC voice fallback
- `POST /api/evaluate` game-state evaluation and NPC reply generation

## Project Structure

```text
app/
  api/
    evaluate/      LLM game-state evaluation
    health/        health endpoint
    transcribe/    speech-to-text + emotion hook
    tts/           NPC voice synthesis
  components/      HUD, controls, chat, timer, meters
  page.tsx         main game client
lib/
  mistral.ts       Mistral API helpers
  elevenlabs.ts    ElevenLabs API helpers
  local-emotion.ts local FastAPI emotion client
services/emotion/  Python emotion inference service
public/assets/     backgrounds, sprites, music, SFX
output/web-game/   captured screenshots and state dumps
```

## Scripts

- `npm run dev` start the local dev server
- `npm run build` create a production build
- `npm run start` serve the production build
- `npm run lint` run ESLint

## Notes

- Microphone support depends on browser permissions and `MediaRecorder` support.
- Browser autoplay policies may block voice playback until user interaction.
- The emotion service may require `ffmpeg` to normalize uploaded audio.
- This is a fictional, game-only scenario. The repo is for interactive narrative and voice AI experimentation, not real-world guidance.
