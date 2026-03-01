"use client";

import Image from "next/image";
import { Oxanium, Rajdhani } from "next/font/google";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type NpcMood = "calm" | "suspicious" | "hostile";
type ChatRole = "npc" | "player";
type PlayerEmotion = "angry" | "disgust" | "fear" | "happy" | "neutral" | "sad" | "surprise";
type EmotionScores = Record<PlayerEmotion, number>;

interface HistoryItem {
  role: ChatRole;
  content: string;
}

interface TranscribeResponse {
  transcript?: string;
  emotion?: PlayerEmotion | null;
  emotionScore?: number | null;
  emotionScores?: Partial<Record<PlayerEmotion, number>> | null;
  emotionModel?: string | null;
  emotionSource?: "local-fastapi" | null;
  emotionError?: string | null;
  error?: string;
}

interface TranscriptionResult {
  transcript: string;
  emotion: PlayerEmotion | null;
  emotionScore: number | null;
  emotionScores: EmotionScores | null;
  emotionModel: string | null;
  emotionSource: "local-fastapi" | null;
  emotionError: string | null;
}

interface EvaluateResponse {
  npcReply: string;
  scores: {
    persuasion: number;
    confidence: number;
    hesitation: number;
    consistency: number;
  };
  suspicionDelta: number;
  newSuspicion: number;
  shouldHangUp: boolean;
  revealCode: boolean;
  code: string | null;
  npcMood: NpcMood;
  stage?: number;
  nextStage?: number;
  passStage?: boolean;
  failureReason?: string | null;
}

const START_TIME = 120;
const START_SUSPICION = 50;
const OPENING_LINE_LEVEL_1 =
  "I planted a bomb at your hackathon. You have 2 minutes. Convince me to give you the code.";
const OPENING_LINE_LEVEL_2 =
  "Miao! I took your shiny Suica card. It's mine now! You're not getting on that train.";
const DARKEN_DELAY_MS = 180;
const OPENING_LINE_DELAY_MS = 980;
const BOMB_TIMER_APPEAR_DELAY_MS = 2000;
const BOMB_TICK_VOLUME = 0.3;
const LEVEL1_BGM_SRC = "/assets/Concrete_Empire_2026-02-28T212713.mp3";
const LEVEL2_BGM_SRC = "/assets/Phantom_Yamanote.mp3";
const LEVEL2_LOSE_TRAIN_SFX_PRIMARY = "/assets/train.wav";
const LEVEL2_LOSE_TRAIN_SFX_FALLBACK = "/assets/train.mp3";
const LEVEL1_CALLER_NAME = "Unknown Caller";
const LEVEL2_CALLER_NAME = "Mochi";
const LEVEL1_FINAL_STAGE = 4;
const IC_GATE_HITBOX_DIAMETER_RATIO = 0.13;
const IC_GATE_WIDTH = "clamp(700px, 42vw, 1200px)";
const IC_GATE_BOTTOM_OFFSET = "-16vh";
const IC_GATE_VISUAL_Y_OFFSET = "180px";
const ENABLE_SUICA_MINIGAME_TEST_SKIP = ["1", "true", "yes", "on"].includes(
  (process.env.NEXT_PUBLIC_SUICA_MINIGAME_TEST_SKIP ?? "").trim().toLowerCase()
);

const PLAYER_EMOTIONS: PlayerEmotion[] = [
  "angry",
  "disgust",
  "fear",
  "happy",
  "neutral",
  "sad",
  "surprise"
];

const rajdhani = Rajdhani({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap"
});

const oxanium = Oxanium({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap"
});

const EMOTION_VISUALS: Record<PlayerEmotion, { emoji: string; fill: string; stroke: string; glow: string }> = {
  angry: { emoji: "😠", fill: "#fee2e2", stroke: "#ef4444", glow: "rgba(239,68,68,0.55)" },
  disgust: { emoji: "🤢", fill: "#dcfce7", stroke: "#22c55e", glow: "rgba(34,197,94,0.5)" },
  fear: { emoji: "😨", fill: "#dbeafe", stroke: "#3b82f6", glow: "rgba(59,130,246,0.52)" },
  happy: { emoji: "😄", fill: "#fef9c3", stroke: "#eab308", glow: "rgba(234,179,8,0.5)" },
  neutral: { emoji: "😐", fill: "#f1f5f9", stroke: "#94a3b8", glow: "rgba(148,163,184,0.45)" },
  sad: { emoji: "😢", fill: "#e0f2fe", stroke: "#0ea5e9", glow: "rgba(14,165,233,0.5)" },
  surprise: { emoji: "😮", fill: "#ffedd5", stroke: "#f97316", glow: "rgba(249,115,22,0.5)" }
};

const EMOTION_ADJECTIVES: Record<PlayerEmotion, string> = {
  angry: "angry",
  disgust: "disgusted",
  fear: "afraid",
  happy: "happy",
  neutral: "neutral",
  sad: "sad",
  surprise: "surprised"
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function pickSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function parseEmotionScores(payload: unknown): EmotionScores | null {
  if (!payload || typeof payload !== "object") return null;

  const source = payload as Record<string, unknown>;
  const scores: EmotionScores = {
    angry: 0,
    disgust: 0,
    fear: 0,
    happy: 0,
    neutral: 0,
    sad: 0,
    surprise: 0
  };

  let hasAny = false;
  for (const emotion of PLAYER_EMOTIONS) {
    const raw = Number(source[emotion]);
    if (!Number.isFinite(raw)) continue;
    scores[emotion] = clamp(raw, 0, 1);
    if (raw > 0) hasAny = true;
  }

  return hasAny ? scores : null;
}

function mapSingleEmotionScore(emotion: PlayerEmotion | null, score: number | null): EmotionScores | null {
  if (!emotion || typeof score !== "number" || !Number.isFinite(score) || score <= 0) return null;
  const clamped = clamp(score, 0, 1);
  return {
    angry: emotion === "angry" ? clamped : 0,
    disgust: emotion === "disgust" ? clamped : 0,
    fear: emotion === "fear" ? clamped : 0,
    happy: emotion === "happy" ? clamped : 0,
    neutral: emotion === "neutral" ? clamped : 0,
    sad: emotion === "sad" ? clamped : 0,
    surprise: emotion === "surprise" ? clamped : 0
  };
}

function inferEmotionFromTranscript(transcript: string): {
  emotion: PlayerEmotion | null;
  score: number | null;
  scores: EmotionScores | null;
} {
  const text = transcript.trim();
  if (!text) return { emotion: null, score: null, scores: null };

  const lower = text.toLowerCase();
  const letters = text.replace(/[^a-zA-Z]/g, "");
  const upperLetters = letters.replace(/[^A-Z]/g, "");
  const upperRatio = letters.length > 0 ? upperLetters.length / letters.length : 0;
  const exclamationCount = (text.match(/!/g) ?? []).length;

  const angryIntent =
    /(now|immediately|right now|listen to me|do it|give me the code|last warning|or else|hurle|crie|vite)/i.test(
      lower
    ) ||
    exclamationCount >= 2 ||
    (letters.length >= 8 && upperRatio >= 0.45);

  if (angryIntent) {
    const score = clamp(0.58 + Math.min(exclamationCount, 4) * 0.08 + upperRatio * 0.24, 0.58, 0.98);
    return { emotion: "angry", score, scores: mapSingleEmotionScore("angry", score) };
  }

  if (/(please|sorry|i'm scared|i am scared|peur|stressed|stress)/i.test(lower)) {
    const score = 0.54;
    return { emotion: "fear", score, scores: mapSingleEmotionScore("fear", score) };
  }

  return { emotion: null, score: null, scores: null };
}

function shouldIgnoreHotkey(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || tag === "button";
}

export default function Home() {
  const [hasStarted, setHasStarted] = useState(false);
  const [showCharacter, setShowCharacter] = useState(false);
  const [showOpeningLine, setShowOpeningLine] = useState(false);
  const [canTalk, setCanTalk] = useState(false);
  const [currentLevel, setCurrentLevel] = useState<1 | 2>(1);
  const [titleHoverLevel, setTitleHoverLevel] = useState<1 | 2 | null>(null);

  const [timeRemaining, setTimeRemaining] = useState(START_TIME);
  const [timerRunning, setTimerRunning] = useState(false);

  const [suspicion, setSuspicion] = useState(START_SUSPICION);
  const [npcMood, setNpcMood] = useState<NpcMood>("suspicious");
  const [stage, setStage] = useState(1);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [lastTranscript, setLastTranscript] = useState("");
  const [lastEmotion, setLastEmotion] = useState<PlayerEmotion | null>(null);
  const [lastEmotionScore, setLastEmotionScore] = useState<number | null>(null);
  const [lastEmotionScores, setLastEmotionScores] = useState<EmotionScores | null>(null);

  const [recordingSupported, setRecordingSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [micError, setMicError] = useState("");
  const [isNpcSpeaking, setIsNpcSpeaking] = useState(false);
  const [hasMicPrimed, setHasMicPrimed] = useState(false);

  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [playerCodeInput, setPlayerCodeInput] = useState("");
  const [won, setWon] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [explosionFlashVisible, setExplosionFlashVisible] = useState(false);
  const [destroyedBackgroundVisible, setDestroyedBackgroundVisible] = useState(false);
  const [isSceneShaking, setIsSceneShaking] = useState(false);
  const [isBombTimerVisible, setIsBombTimerVisible] = useState(false);
  const [isSuicaChallengeActive, setIsSuicaChallengeActive] = useState(false);
  const [isSuicaGateHot, setIsSuicaGateHot] = useState(false);
  const [suicaCursorPosition, setSuicaCursorPosition] = useState({ x: 0, y: 0 });

  const [statusLine, setStatusLine] = useState("Awaiting call start...");

  const busy = isTranscribing || loading;

  const historyRef = useRef<HistoryItem[]>([]);
  const npcAudioRef = useRef<HTMLAudioElement | null>(null);
  const explosionAudioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const recordingSessionRef = useRef(0);
  const audioUnlockedRef = useRef(false);
  const previousTimerValueRef = useRef(START_TIME);
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const suicaGateRef = useRef<HTMLDivElement | null>(null);
  const suicaHitboxRef = useRef<HTMLDivElement | null>(null);
  const pointerPositionRef = useRef({ x: 0, y: 0 });

  const darkenTimeoutRef = useRef<number | null>(null);
  const openingLineTimeoutRef = useRef<number | null>(null);
  const talkReadyTimeoutRef = useRef<number | null>(null);
  const bombTimerRevealTimeoutRef = useRef<number | null>(null);

  const replaceHistory = useCallback((next: HistoryItem[]) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const unlockAudioPlayback = useCallback(async () => {
    if (audioUnlockedRef.current) return;

    try {
      const silentAudio = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=");
      silentAudio.volume = 0;
      await silentAudio.play();
      silentAudio.pause();
      silentAudio.currentTime = 0;
      audioUnlockedRef.current = true;
      console.info("🔓  [TTS] Browser audio unlocked");
    } catch (error) {
      console.warn("⚠️  [TTS] Audio unlock did not complete yet", error);
    }
  }, []);

  const stopNpcVoice = useCallback(() => {
    const audio = npcAudioRef.current;
    if (!audio) {
      setIsNpcSpeaking(false);
      return;
    }

    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.src = "";
    npcAudioRef.current = null;
    setIsNpcSpeaking(false);
  }, []);

  const stopExplosionSound = useCallback(() => {
    const audio = explosionAudioRef.current;
    if (!audio) return;

    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.currentTime = 0;
    explosionAudioRef.current = null;
  }, []);

  const playExplosionSound = useCallback(async () => {
    stopExplosionSound();
    const audio = new Audio("/assets/booom.mp3");
    audio.preload = "auto";
    audio.volume = 1;
    audio.currentTime = 0;
    explosionAudioRef.current = audio;

    audio.onended = () => {
      if (explosionAudioRef.current === audio) {
        explosionAudioRef.current = null;
      }
    };

    audio.onerror = (event) => {
      if (explosionAudioRef.current === audio) {
        explosionAudioRef.current = null;
      }
      console.error("🚨  [SFX] Explosion sound playback failed", event);
    };

    try {
      await audio.play();
      console.info("💥🔊  [SFX] Explosion sound played at max volume");
    } catch (error) {
      if (explosionAudioRef.current === audio) {
        explosionAudioRef.current = null;
      }
      console.error("🚨  [SFX] Browser blocked explosion sound playback", error);
    }
  }, [stopExplosionSound]);

  const playLevel2LoseTrainSound = useCallback(async () => {
    stopExplosionSound();
    const candidates = [LEVEL2_LOSE_TRAIN_SFX_PRIMARY, LEVEL2_LOSE_TRAIN_SFX_FALLBACK];

    for (const src of candidates) {
      const audio = new Audio(src);
      audio.preload = "auto";
      audio.volume = 1;
      audio.currentTime = 0;
      explosionAudioRef.current = audio;

      audio.onended = () => {
        if (explosionAudioRef.current === audio) {
          explosionAudioRef.current = null;
        }
      };

      audio.onerror = (event) => {
        if (explosionAudioRef.current === audio) {
          explosionAudioRef.current = null;
        }
        console.warn("⚠️  [SFX] Level 2 train sound load/playback error", { src, event });
      };

      try {
        await audio.play();
        console.info("🚆🔊  [SFX] Level 2 lose train sound played", { src });
        return;
      } catch (error) {
        if (explosionAudioRef.current === audio) {
          explosionAudioRef.current = null;
        }
        console.warn("⚠️  [SFX] Level 2 train sound attempt failed", { src, error });
      }
    }

    console.error("🚨  [SFX] Level 2 lose train sound unavailable after fallback attempts");
  }, [stopExplosionSound]);

  const speakNpcLine = useCallback(
    async (text: string, mood: NpcMood, suspicionLevel: number, level: number, onDone?: () => void) => {
      const cleaned = text.trim();
      if (!cleaned) return;

      stopNpcVoice();
      const params = new URLSearchParams({
        text: cleaned,
        level: String(level),
        suspicion: String(Math.round(clamp(suspicionLevel, 0, 100))),
        mood
      });
      const ttsUrl = `/api/tts?${params.toString()}`;
      const audio = new Audio(ttsUrl);
      audio.preload = "auto";
      npcAudioRef.current = audio;
      setIsNpcSpeaking(true);

      console.info("🔊  [TTS] Playing NPC voice", {
        chars: cleaned.length,
        mood,
        suspicion: Math.round(clamp(suspicionLevel, 0, 100))
      });

      audio.onended = () => {
        if (npcAudioRef.current === audio) {
          npcAudioRef.current = null;
        }
        setIsNpcSpeaking(false);
        onDone?.();
        console.info("✅  [TTS] NPC voice playback ended");
      };

      audio.onerror = (event) => {
        if (npcAudioRef.current === audio) {
          npcAudioRef.current = null;
        }
        setIsNpcSpeaking(false);
        onDone?.();
        setStatusLine("Caller audio unavailable. Continue the call.");
        console.error("🚨  [TTS] NPC voice playback failed", event);
      };

      try {
        await audio.play();
      } catch (error) {
        if (npcAudioRef.current === audio) {
          npcAudioRef.current = null;
        }
        setIsNpcSpeaking(false);
        onDone?.();
        setStatusLine("Browser blocked caller audio. Continue the call.");
        console.error("🚨  [TTS] Browser blocked or failed audio playback", error);
      }
    },
    [stopNpcVoice]
  );

  const releaseMicrophone = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const stopRecording = useCallback((discard: boolean = false) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      setIsRecording(false);
      return;
    }

    if (recorder.state === "recording") {
      discardRecordingRef.current = discard;
      try {
        recorder.stop();
      } catch {
        // Ignore stop failure.
      }
    } else {
      setIsRecording(false);
    }
  }, []);

  const triggerExplosion = useCallback(
    (reason: string) => {
      if (exploded || won) return;

      stopRecording(true);
      stopNpcVoice();
      setExploded(true);
      setTimerRunning(false);
      setCanTalk(false);
      setStatusLine(`BOOM · ${reason}`);
      console.error("💥  [Bomb] Device exploded", { reason, timeRemaining, suspicion, revealedCode });
    },
    [exploded, revealedCode, stopNpcVoice, stopRecording, suspicion, timeRemaining, won]
  );

  const transcribeBlob = useCallback(async (audioBlob: Blob): Promise<TranscriptionResult> => {
    const ext = audioBlob.type.includes("ogg") ? "ogg" : audioBlob.type.includes("mp4") ? "mp4" : "webm";
    const file = new File([audioBlob], `turn-${Date.now()}.${ext}`, {
      type: audioBlob.type || "audio/webm"
    });

    const formData = new FormData();
    formData.append("audio", file);
    formData.append("language", "en");
    formData.append("analyzeEmotion", "1");

    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData
    });

    const payload = (await response.json().catch(() => ({}))) as TranscribeResponse;
    if (!response.ok) {
      throw new Error(payload.error || "Transcription failed.");
    }

    const transcript = (payload.transcript || "").trim();
    if (!transcript) {
      throw new Error("No transcript returned.");
    }

    return {
      transcript,
      emotion: payload.emotion ?? null,
      emotionScore: typeof payload.emotionScore === "number" ? payload.emotionScore : null,
      emotionScores: parseEmotionScores(payload.emotionScores),
      emotionModel: typeof payload.emotionModel === "string" ? payload.emotionModel : null,
      emotionSource: payload.emotionSource === "local-fastapi" ? "local-fastapi" : null,
      emotionError: typeof payload.emotionError === "string" ? payload.emotionError : null
    };
  }, []);

  const submitTurn = useCallback(
    async (
      transcript: string,
      emotion: PlayerEmotion | null,
      emotionScore: number | null,
      emotionScores: EmotionScores | null
    ) => {
      if (!transcript.trim() || exploded || won || !timerRunning) return;

      setLoading(true);
      setLastTranscript(transcript);
      setLastEmotion(emotion);
      setLastEmotionScore(emotionScore);
      setLastEmotionScores(emotionScores);

      const playerLine: HistoryItem = { role: "player", content: transcript.trim() };
      const withPlayer = [...historyRef.current, playerLine];
      replaceHistory(withPlayer);

      const round = withPlayer.filter((line) => line.role === "player").length;

      console.info("🗣️  [Turn] Player transcript", {
        transcript,
        emotion,
        emotionScore,
        emotionScores,
        timeRemaining,
        suspicion,
        stage,
        round,
        conversation: withPlayer
      });

      if (ENABLE_SUICA_MINIGAME_TEST_SKIP && currentLevel === 2 && round === 1 && !isSuicaChallengeActive) {
        const shortcutLine = "Purr... shortcut enabled. Take your Suica card and tap the IC gate now.";
        const npcLine: HistoryItem = { role: "npc", content: shortcutLine };
        replaceHistory([...withPlayer, npcLine]);
        setNpcMood("calm");
        setStage(3);
        setRevealedCode("TEST");
        setIsSuicaChallengeActive(true);
        setTimerRunning(false);
        setCanTalk(false);
        setSuicaCursorPosition(pointerPositionRef.current);
        setStatusLine("🧪  Test mode: timer paused, move your Suica card onto the red IC target.");
        console.info("🧪  [Level2] First-audio shortcut -> Suica gate challenge", {
          round,
          cursor: pointerPositionRef.current
        });
        void speakNpcLine(shortcutLine, "calm", suspicion, currentLevel);
        setLoading(false);
        return;
      }

      try {
        const response = await fetch("/api/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript,
            timeRemaining,
            suspicion,
            history: withPlayer,
            round,
            stage,
            level: currentLevel,
            playerEmotion: emotion,
            emotionScore
          })
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.error || "Evaluate failed.");
        }

        const data = (await response.json()) as EvaluateResponse;
        const npcLine: HistoryItem = { role: "npc", content: data.npcReply };
        const withNpc = [...withPlayer, npcLine];
        replaceHistory(withNpc);

        setSuspicion(clamp(data.newSuspicion, 0, 100));
        setNpcMood(data.npcMood);
        if (typeof data.nextStage === "number" && Number.isFinite(data.nextStage)) {
          setStage(clamp(Math.round(data.nextStage), 1, LEVEL1_FINAL_STAGE));
        }

        console.info("🎭  [Turn] NPC evaluation", {
          npcReply: data.npcReply,
          scores: data.scores,
          suspicionDelta: data.suspicionDelta,
          newSuspicion: data.newSuspicion,
          shouldHangUp: data.shouldHangUp,
          revealCode: data.revealCode,
          code: data.code,
          npcMood: data.npcMood,
          stage: data.stage,
          nextStage: data.nextStage,
          passStage: data.passStage,
          failureReason: data.failureReason,
          conversation: withNpc
        });

        if (data.revealCode && data.code) {
          setRevealedCode(data.code);
          if (currentLevel === 2) {
            setIsSuicaChallengeActive(true);
            setCanTalk(false);
            setSuicaCursorPosition(pointerPositionRef.current);
            setStatusLine("🪪  Move your Suica card onto the red IC target.");
            console.info("🚉  [Level2] Suica gate challenge started", {
              cursor: pointerPositionRef.current,
              stage: data.nextStage
            });
          } else {
            setStatusLine("Code leaked. Enter it on the bomb panel.");
          }
        } else if (data.shouldHangUp) {
          setStatusLine("Caller mocks you. Keep trying before the timer hits zero.");
        } else {
          const nextStage =
            typeof data.nextStage === "number" ? clamp(Math.round(data.nextStage), 1, LEVEL1_FINAL_STAGE) : stage;
          setStatusLine(`Stage ${nextStage}/${LEVEL1_FINAL_STAGE}.`);
        }

        void speakNpcLine(data.npcReply, data.npcMood, data.newSuspicion, currentLevel);

        if (data.shouldHangUp) {
          const reason = data.failureReason?.trim() || "Failed dialogue stage";
          console.warn("📴  [Call] Stage failed; no instant explosion mode active", { reason });
        }
      } catch (error) {
        console.error("🚨  [Turn] Evaluation error", error);
        setStatusLine("Connection glitch. Retry voice input.");
      } finally {
        setLoading(false);
      }
    },
    [
      currentLevel,
      exploded,
      isSuicaChallengeActive,
      replaceHistory,
      speakNpcLine,
      stage,
      suspicion,
      timeRemaining,
      timerRunning,
      won
    ]
  );

  const startAutoRecording = useCallback(async () => {
    void unlockAudioPlayback();
    if (!hasStarted || !canTalk || busy || isRecording || timeRemaining <= 0 || exploded || won) return;
    if (isNpcSpeaking) {
      setStatusLine("Wait for caller to finish.");
      return;
    }

    if (!recordingSupported) {
      setMicError("Browser microphone recording is unavailable.");
      return;
    }

    setMicError("");

    try {
      let stream = mediaStreamRef.current;
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        mediaStreamRef.current = stream;
      }

      const mimeType = pickSupportedMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const sessionId = recordingSessionRef.current + 1;

      recordingSessionRef.current = sessionId;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      discardRecordingRef.current = false;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.error("🚨  [Audio] Recorder error", event);
        setMicError("Microphone recorder failed. Retry.");
        setIsRecording(false);
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        mediaRecorderRef.current = null;

        if (discardRecordingRef.current) {
          discardRecordingRef.current = false;
          audioChunksRef.current = [];
          return;
        }

        if (recordingSessionRef.current !== sessionId) return;

        const audioBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm"
        });
        audioChunksRef.current = [];

        if (audioBlob.size < 150) {
          setMicError("Audio too short. Keep speaking a bit longer.");
          return;
        }

        setIsTranscribing(true);
        setStatusLine("Analyzing voice...");

        try {
          const result = await transcribeBlob(audioBlob);
          if (recordingSessionRef.current !== sessionId) return;

          const shouldUseTextFallback = !result.emotion;
          const fallback = shouldUseTextFallback
            ? inferEmotionFromTranscript(result.transcript)
            : { emotion: null, score: null, scores: null };
          const finalEmotion = result.emotion ?? fallback.emotion;
          const finalEmotionScore = result.emotionScore ?? fallback.score;
          const finalEmotionScores = result.emotionScores ?? fallback.scores;
          const emotionSource = result.emotion
            ? "local-fastapi"
            : shouldUseTextFallback
              ? "fallback-text"
              : "none";

          if (!result.emotion && result.emotionError) {
            setMicError("");
            console.info("ℹ️  [Emotion] Local emotion service unavailable, using transcript fallback", {
              emotionError: result.emotionError
            });
          }

          console.info("🧠  [Emotion] Voice analysis", {
            transcript: result.transcript,
            emotion: finalEmotion,
            emotionScore: finalEmotionScore,
            emotionScores: finalEmotionScores,
            source: emotionSource,
            model: result.emotionModel,
            error: result.emotionError
          });

          await submitTurn(result.transcript, finalEmotion, finalEmotionScore, finalEmotionScores);
        } catch (error) {
          console.error("🚨  [Audio] Transcription error", error);
          setMicError("Could not transcribe audio. Try again.");
          setStatusLine("Mic/transcription issue. Retry speaking.");
        } finally {
          if (recordingSessionRef.current === sessionId) {
            setIsTranscribing(false);
          }
        }
      };

      recorder.start();
      setIsRecording(true);
      setHasMicPrimed(true);
      setStatusLine("Recording... click again to send.");
      console.info("🎙️  [Audio] Recording started from mic button");
    } catch (error) {
      console.error("🚨  [Audio] Unable to start recording", error);
      setMicError("Microphone access denied or unavailable.");
      setStatusLine("Microphone unavailable.");
      setIsRecording(false);
    }
  }, [
    busy,
    canTalk,
    exploded,
    hasStarted,
    isNpcSpeaking,
    isRecording,
    recordingSupported,
    submitTurn,
    timeRemaining,
    transcribeBlob,
    unlockAudioPlayback,
    won
  ]);

  const sendCurrentRecording = useCallback(() => {
    if (!isRecording) return;
    stopRecording(false);
    setStatusLine("Processing your message...");
  }, [isRecording, stopRecording]);

  const playCodeClick = useCallback(() => {
    if (typeof window === "undefined" || typeof window.AudioContext === "undefined") return;

    try {
      const ctx = new window.AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "square";
      osc.frequency.setValueAtTime(1650, ctx.currentTime);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.04);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.045);
      window.setTimeout(() => {
        void ctx.close();
      }, 120);
    } catch (error) {
      console.warn("⚠️  [Bomb] Code click sound failed", error);
    }
  }, []);

  const playBombTick = useCallback(() => {
    if (typeof window === "undefined" || typeof window.AudioContext === "undefined") return;

    try {
      const ctx = new window.AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "square";
      osc.frequency.setValueAtTime(920, ctx.currentTime);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(BOMB_TICK_VOLUME, ctx.currentTime + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.085);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.09);
      window.setTimeout(() => {
        void ctx.close();
      }, 180);
    } catch (error) {
      console.warn("⚠️  [Bomb] Tick sound failed", error);
    }
  }, []);

  const playSuicaBip = useCallback(() => {
    if (typeof window === "undefined") return;

    try {
      const audio = new Audio("/assets/bip.wav");
      audio.volume = 0.95;
      audio.currentTime = 0;
      void audio.play().catch((error) => {
        console.warn("⚠️  [Level2] Suica gate bip failed", error);
      });
    } catch (error) {
      console.warn("⚠️  [Level2] Suica gate bip setup failed", error);
    }
  }, []);

  const completeSuicaGateChallenge = useCallback(() => {
    if (!isSuicaChallengeActive || currentLevel !== 2 || won || exploded) return;

    playSuicaBip();
    setIsSuicaChallengeActive(false);
    setIsSuicaGateHot(false);
    setTimerRunning(false);
    setCanTalk(false);
    setWon(true);
    setStatusLine("🚉  Suica scanned. Gate opened. You caught the train.");
    console.info("✅  [Level2] Suica scanned at IC gate", { timeRemaining, sfx: "bip.wav" });
  }, [currentLevel, exploded, isSuicaChallengeActive, playSuicaBip, timeRemaining, won]);

  const evaluateSuicaGateHit = useCallback(
    (pointerX: number, pointerY: number) => {
      if (!isSuicaChallengeActive || currentLevel !== 2 || won || exploded) {
        setIsSuicaGateHot(false);
        return;
      }

      const hitboxElement = suicaHitboxRef.current;
      if (!hitboxElement) {
        const gateElement = suicaGateRef.current;
        if (!gateElement) {
          setIsSuicaGateHot(false);
          return;
        }

        const gateRect = gateElement.getBoundingClientRect();
        const centerX = gateRect.left + gateRect.width * 0.5;
        const centerY = gateRect.top + gateRect.height * 0.5;
        const hitboxRadius = Math.min(gateRect.width, gateRect.height) * IC_GATE_HITBOX_DIAMETER_RATIO * 0.5;
        const distanceFromCenter = Math.hypot(pointerX - centerX, pointerY - centerY);
        const isInsideHitbox = distanceFromCenter <= hitboxRadius;

        setIsSuicaGateHot(isInsideHitbox);

        if (isInsideHitbox) {
          completeSuicaGateChallenge();
        }
        return;
      }

      const hitboxRect = hitboxElement.getBoundingClientRect();
      const centerX = hitboxRect.left + hitboxRect.width * 0.5;
      const centerY = hitboxRect.top + hitboxRect.height * 0.5;
      const hitboxRadius = Math.min(hitboxRect.width, hitboxRect.height) * 0.5;
      const distanceFromCenter = Math.hypot(pointerX - centerX, pointerY - centerY);
      const isInsideHitbox = distanceFromCenter <= hitboxRadius;

      setIsSuicaGateHot(isInsideHitbox);

      if (isInsideHitbox) {
        completeSuicaGateChallenge();
      }
    },
    [completeSuicaGateChallenge, currentLevel, exploded, isSuicaChallengeActive, won]
  );

  const handleCodeSubmit = useCallback((overrideCode?: string) => {
    if (won || exploded) return;

    const attemptedCode = (overrideCode ?? playerCodeInput).trim();
    console.info("🧨  [Bomb] Code attempt", {
      attemptedCode,
      expectedCode: revealedCode,
      timeRemaining
    });

    if (revealedCode && attemptedCode === revealedCode) {
      setWon(true);
      setTimerRunning(false);
      setCanTalk(false);
      setStatusLine(currentLevel === 1 ? "DEVICE DISARMED" : "SUICA RECOVERED");
      console.info("✅  [Bomb] Correct code, device disarmed", { code: attemptedCode, timeRemaining });
      return;
    }

    setStatusLine("Wrong code. Try again before timer ends.");
    console.warn("⚠️  [Bomb] Wrong code, no instant explosion (timer remains the only fail condition).");
  }, [currentLevel, exploded, playerCodeInput, revealedCode, timeRemaining, won]);

  const clearIntroSequenceTimers = useCallback(() => {
    if (darkenTimeoutRef.current !== null) {
      window.clearTimeout(darkenTimeoutRef.current);
      darkenTimeoutRef.current = null;
    }
    if (openingLineTimeoutRef.current !== null) {
      window.clearTimeout(openingLineTimeoutRef.current);
      openingLineTimeoutRef.current = null;
    }
    if (talkReadyTimeoutRef.current !== null) {
      window.clearTimeout(talkReadyTimeoutRef.current);
      talkReadyTimeoutRef.current = null;
    }
    if (bombTimerRevealTimeoutRef.current !== null) {
      window.clearTimeout(bombTimerRevealTimeoutRef.current);
      bombTimerRevealTimeoutRef.current = null;
    }
  }, []);

  const startGameSequence = useCallback((forceRestart: boolean = false, levelToPlay?: 1 | 2) => {
    if (hasStarted && !forceRestart) return;

    if (levelToPlay) {
      setCurrentLevel(levelToPlay);
    }

    void unlockAudioPlayback();
    clearIntroSequenceTimers();
    stopRecording(true);
    stopNpcVoice();
    stopExplosionSound();

    setWon(false);
    setExploded(false);
    setExplosionFlashVisible(false);
    setDestroyedBackgroundVisible(false);
    setIsSceneShaking(false);
    setIsBombTimerVisible(false);
    setIsSuicaChallengeActive(false);
    setIsSuicaGateHot(false);
    setSuicaCursorPosition(pointerPositionRef.current);
    setRevealedCode(null);
    setPlayerCodeInput("");
    setSuspicion(START_SUSPICION);
    setNpcMood("suspicious");
    setStage(1);
    setLastTranscript("");
    setLastEmotion(null);
    setLastEmotionScore(null);
    setLastEmotionScores(null);
    setIsRecording(false);
    setIsTranscribing(false);
    setLoading(false);
    setHasMicPrimed(false);

    replaceHistory([]);
    setHasStarted(true);
    setShowCharacter(false);
    setShowOpeningLine(false);
    setCanTalk(false);
    setTimerRunning(false);
    previousTimerValueRef.current = START_TIME;
    setTimeRemaining(START_TIME);
    setStatusLine("Connecting secure call...");
    setMicError("");

    console.info("🚀  [Intro] Enter pressed, starting call sequence");

    darkenTimeoutRef.current = window.setTimeout(() => {
      setShowCharacter(true);
    }, DARKEN_DELAY_MS);

    bombTimerRevealTimeoutRef.current = window.setTimeout(() => {
      setIsBombTimerVisible(true);
    }, BOMB_TIMER_APPEAR_DELAY_MS);

    openingLineTimeoutRef.current = window.setTimeout(() => {
      setShowOpeningLine(true);
      const targetLevel = levelToPlay ?? currentLevel;
      const startLine = targetLevel === 1 ? OPENING_LINE_LEVEL_1 : OPENING_LINE_LEVEL_2;
      const callerName = targetLevel === 2 ? LEVEL2_CALLER_NAME : LEVEL1_CALLER_NAME;
      replaceHistory([{ role: "npc", content: startLine }]);
      setTimerRunning(true);
      setStatusLine(`${callerName} is speaking...`);
      void speakNpcLine(startLine, "suspicious", START_SUSPICION, targetLevel, () => {
        setCanTalk(true);
        setStatusLine("Your turn. Click the mic button to speak.");
        console.info("🎙️  [Intro] Click-to-record mode enabled after opening line");
      });
      console.info("📞  [Intro] Opening line displayed, timer started");
    }, OPENING_LINE_DELAY_MS);
    talkReadyTimeoutRef.current = null;
  }, [
    currentLevel,
    clearIntroSequenceTimers,
    hasStarted,
    replaceHistory,
    speakNpcLine,
    stopExplosionSound,
    stopNpcVoice,
    stopRecording,
    unlockAudioPlayback
  ]);

  const handleRetry = useCallback(() => {
    console.info("🔁  [Game] Retry requested");
    startGameSequence(true, currentLevel);
  }, [startGameSequence, currentLevel]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    if (!history.length) return;
    const latest = history[history.length - 1];
    console.info("💬  [Conversation] New line", latest);
    console.info("📚  [Conversation] Full history", history);
  }, [history]);

  useEffect(() => {
    console.info("📊  [Status] Suspicion + mood", { suspicion, npcMood });
  }, [npcMood, suspicion]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const hasMediaRecorder =
      typeof window.MediaRecorder !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function";

    setRecordingSupported(hasMediaRecorder);
    console.info("🎛️  [Init] Microphone support", { hasMediaRecorder });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const initial = {
      x: Math.round(window.innerWidth * 0.5),
      y: Math.round(window.innerHeight * 0.5)
    };
    pointerPositionRef.current = initial;
    setSuicaCursorPosition(initial);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onMouseMove = (event: MouseEvent) => {
      const next = { x: event.clientX, y: event.clientY };
      pointerPositionRef.current = next;

      if (!isSuicaChallengeActive) return;

      setSuicaCursorPosition(next);
      evaluateSuicaGateHit(next.x, next.y);
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, [evaluateSuicaGateHit, isSuicaChallengeActive]);

  useEffect(() => {
    if (isSuicaChallengeActive) return;
    setIsSuicaGateHot(false);
  }, [isSuicaChallengeActive]);

  useEffect(() => {
    if (!ENABLE_SUICA_MINIGAME_TEST_SKIP || !isSuicaChallengeActive || currentLevel !== 2 || !timerRunning) return;
    setTimerRunning(false);
    console.info("⏸️  [Level2] Timer paused during Suica gate challenge (test shortcut)");
  }, [currentLevel, isSuicaChallengeActive, timerRunning]);

  useEffect(() => {
    if (!isSuicaChallengeActive) return;
    evaluateSuicaGateHit(pointerPositionRef.current.x, pointerPositionRef.current.y);
  }, [evaluateSuicaGateHit, isSuicaChallengeActive]);

  useEffect(() => {
    if (hasStarted) return;

    const onEnterDown = (event: KeyboardEvent) => {
      if (event.code !== "Enter") return;
      if (shouldIgnoreHotkey(event.target)) return;
      event.preventDefault();
      void startGameSequence();
    };

    window.addEventListener("keydown", onEnterDown);

    return () => {
      window.removeEventListener("keydown", onEnterDown);
    };
  }, [hasStarted, startGameSequence]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const targetBgm = currentLevel === 2 ? LEVEL2_BGM_SRC : LEVEL1_BGM_SRC;

    if (!bgmAudioRef.current) {
      const audio = new Audio(targetBgm);
      audio.loop = true;
      audio.volume = 0.15;
      bgmAudioRef.current = audio;
    }

    const bgm = bgmAudioRef.current;
    const resolvedTargetBgm = new URL(targetBgm, window.location.origin).href;

    if (bgm.src !== resolvedTargetBgm) {
      bgm.pause();
      bgm.src = targetBgm;
      bgm.currentTime = 0;
      console.info("🎵  [BGM] Track switched", {
        level: currentLevel,
        track: targetBgm
      });
    }

    const shouldPlay = !exploded && !won && (!hasStarted || currentLevel === 1 || currentLevel === 2);

    const tryPlay = () => {
      if (shouldPlay && bgm.paused) {
        bgm.play().catch((error) => {
          console.warn("⚠️  [BGM] Browser blocked background music", {
            level: currentLevel,
            track: targetBgm,
            error
          });
        });
      }
    };

    if (shouldPlay) {
      tryPlay();
    } else {
      bgm.pause();
    }

    const handleInteraction = () => {
      if (shouldPlay) tryPlay();
    };

    window.addEventListener("click", handleInteraction, { passive: true });
    window.addEventListener("keydown", handleInteraction, { passive: true });

    return () => {
      window.removeEventListener("click", handleInteraction);
      window.removeEventListener("keydown", handleInteraction);
    };
  }, [hasStarted, currentLevel, exploded, won]);

  useEffect(() => {
    if (!exploded) return;

    const onEnterRetry = (event: KeyboardEvent) => {
      if (event.code !== "Enter") return;
      if (shouldIgnoreHotkey(event.target)) return;
      event.preventDefault();
      handleRetry();
    };

    window.addEventListener("keydown", onEnterRetry);

    return () => {
      window.removeEventListener("keydown", onEnterRetry);
    };
  }, [exploded, handleRetry]);

  const handleMicButtonClick = useCallback(() => {
    if (!hasStarted || !canTalk || exploded || won || timeRemaining <= 0) return;
    if (busy) return;
    if (isNpcSpeaking) {
      setStatusLine("Wait for caller to finish.");
      return;
    }

    if (isRecording) {
      sendCurrentRecording();
      return;
    }

    void startAutoRecording();
  }, [
    busy,
    canTalk,
    exploded,
    hasStarted,
    isNpcSpeaking,
    isRecording,
    sendCurrentRecording,
    startAutoRecording,
    timeRemaining,
    won
  ]);

  useEffect(() => {
    if (!timerRunning || exploded || won) return;

    const interval = window.setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval);
          triggerExplosion("Time out");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [exploded, timerRunning, triggerExplosion, won]);

  useEffect(() => {
    if (!timerRunning || exploded || won || currentLevel !== 1) {
      previousTimerValueRef.current = timeRemaining;
      return;
    }

    if (timeRemaining > 0 && timeRemaining < previousTimerValueRef.current) {
      playBombTick();
    }

    previousTimerValueRef.current = timeRemaining;
  }, [currentLevel, exploded, playBombTick, timeRemaining, timerRunning, won]);

  useEffect(() => {
    if (!exploded) return;

    void unlockAudioPlayback();
    if (currentLevel === 1) {
      void playExplosionSound();
    } else {
      void playLevel2LoseTrainSound();
    }
    setIsSceneShaking(true);
    setExplosionFlashVisible(true);
    setDestroyedBackgroundVisible(false);

    const hideFlash = window.setTimeout(() => {
      setExplosionFlashVisible(false);
    }, 230);

    const showDestroyed = window.setTimeout(() => {
      setDestroyedBackgroundVisible(true);
    }, 260);

    const stopShake = window.setTimeout(() => {
      setIsSceneShaking(false);
    }, 950);

    return () => {
      window.clearTimeout(hideFlash);
      window.clearTimeout(showDestroyed);
      window.clearTimeout(stopShake);
    };
  }, [currentLevel, exploded, playExplosionSound, playLevel2LoseTrainSound, unlockAudioPlayback]);

  useEffect(() => {
    if (!won) return;
    stopNpcVoice();
  }, [stopNpcVoice, won]);

  useEffect(() => {
    return () => {
      clearIntroSequenceTimers();
      stopRecording(true);
      stopNpcVoice();
      stopExplosionSound();
      releaseMicrophone();
      if (bgmAudioRef.current) {
        bgmAudioRef.current.pause();
      }
    };
  }, [clearIntroSequenceTimers, releaseMicrophone, stopExplosionSound, stopNpcVoice, stopRecording]);

  const latestNpcLine = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === "npc") return history[i].content;
    }
    return currentLevel === 1 ? OPENING_LINE_LEVEL_1 : OPENING_LINE_LEVEL_2;
  }, [history, currentLevel]);

  const topEmotionDetail = useMemo(() => {
    if (!lastEmotionScores) return null;

    const entries = Object.entries(lastEmotionScores) as Array<[PlayerEmotion, number]>;
    entries.sort((a, b) => b[1] - a[1]);
    const [emotion, score] = entries[0] ?? [null, 0];
    if (!emotion || !Number.isFinite(score) || score <= 0) return null;
    return { emotion, score };
  }, [lastEmotionScores]);

  const emotionConfidencePct = useMemo(() => {
    const sourceScore =
      typeof lastEmotionScore === "number" && Number.isFinite(lastEmotionScore)
        ? lastEmotionScore
        : topEmotionDetail?.score ?? null;
    if (typeof sourceScore !== "number" || !Number.isFinite(sourceScore) || sourceScore <= 0) return null;
    return Math.round(clamp(sourceScore, 0, 1) * 100);
  }, [lastEmotionScore, topEmotionDetail]);

  const recognizedEmotion = lastEmotion ?? topEmotionDetail?.emotion ?? null;
  const recognizedEmotionVisual = recognizedEmotion ? EMOTION_VISUALS[recognizedEmotion] : null;

  const characterImageSrc = useMemo(() => {
    if (currentLevel === 2) {
      if (won) return "/assets/NPC2final.png";
      if (isSuicaChallengeActive) return "/assets/NPC2win.png";
      if (recognizedEmotion === "angry") return "/assets/NPC2angry.png";
      if (recognizedEmotion === "fear") return "/assets/NPC2scared.png";
      return "/assets/NPC2.png";
    }
    if (revealedCode) return "/assets/defeat.png";
    const playerTurns = history.filter((line) => line.role === "player").length;
    return playerTurns >= 2 ? "/assets/angrycat.png" : "/assets/cat2.png";
  }, [currentLevel, history, isSuicaChallengeActive, recognizedEmotion, revealedCode, won]);

  const callerName = currentLevel === 2 ? LEVEL2_CALLER_NAME : LEVEL1_CALLER_NAME;

  return (
    <main className={`relative h-screen w-screen overflow-hidden select-none ${isSceneShaking ? "explode-shake" : ""}`}>
      <p className="sr-only" aria-live="polite">
        {statusLine}
      </p>

      <div className="absolute inset-0 z-0">
        <Image
          src={currentLevel === 1 ? "/assets/background_1.png" : "/assets/background_2.png"}
          alt="Background"
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
      </div>

      <div
        className={`pointer-events-none absolute inset-0 z-10 bg-black transition-opacity duration-[1400ms] ease-out ${hasStarted && !destroyedBackgroundVisible ? (currentLevel === 2 ? "opacity-50" : "opacity-60") : "opacity-0"
          }`}
      />

      {!hasStarted ? (
        <div className={`absolute inset-0 z-30 flex items-center justify-center px-4 py-6 md:px-8 ${rajdhani.className}`}>
          <div className="title-screen-vignette" />
          <div className="title-screen-grid" />
          <div className="title-screen-scan" />
          <div className="title-screen-lightbeam title-screen-lightbeam-a" />
          <div className="title-screen-lightbeam title-screen-lightbeam-b" />
          <div className="title-screen-radial-pulse" />

          <section
            className="title-stage pointer-events-auto relative w-full max-w-[1080px] px-3 py-3 text-center text-white sm:px-4 md:px-8"
            onMouseLeave={() => setTitleHoverLevel(null)}
          >
            <div className="title-stage-glow" />
            <div className="title-stage-particles" aria-hidden>
              <span className="title-particle title-particle-a" />
              <span className="title-particle title-particle-b" />
              <span className="title-particle title-particle-c" />
              <span className="title-particle title-particle-d" />
              <span className="title-particle title-particle-e" />
            </div>
            <div className="title-hover-ghost-layer" aria-hidden>
              <Image
                src="/assets/cat2.png"
                alt=""
                width={1600}
                height={900}
                sizes="(max-width: 768px) 78vw, 42vw"
                className={`title-hover-ghost title-hover-ghost-l1 ${titleHoverLevel === 1 ? "is-active" : ""}`}
              />
              <Image
                src="/assets/NPC2.png"
                alt=""
                width={1200}
                height={1200}
                sizes="(max-width: 768px) 78vw, 42vw"
                className={`title-hover-ghost title-hover-ghost-l2 ${titleHoverLevel === 2 ? "is-active" : ""}`}
              />
            </div>

            <div className="relative z-10">
              <div className="title-logo-wrap mx-auto mt-0 w-[min(90vw,820px)]">
                <Image
                  src="/assets/title-logo.png"
                  alt="Lie Better logo"
                  width={975}
                  height={743}
                  priority
                  sizes="(max-width: 768px) 90vw, 820px"
                  className="title-logo-image h-auto w-full select-none"
                />
              </div>

              <div className="mx-auto mt-4 title-divider" />

              <div className="title-level-row mx-auto mt-0 grid max-w-[640px] gap-4 text-left sm:grid-cols-2">
                <button
                  id="level-1-start-btn"
                  type="button"
                  onClick={() => startGameSequence(false, 1)}
                  onMouseEnter={() => setTitleHoverLevel(1)}
                  onFocus={() => setTitleHoverLevel(1)}
                  onBlur={() => setTitleHoverLevel(null)}
                  className={`title-level-pill title-level-pill-l1 group rounded-2xl px-7 py-4 text-center ${oxanium.className}`}
                >
                  <span className="title-level-pill-text">Level 1</span>
                </button>

                <button
                  id="level-2-start-btn"
                  type="button"
                  onClick={() => startGameSequence(false, 2)}
                  onMouseEnter={() => setTitleHoverLevel(2)}
                  onFocus={() => setTitleHoverLevel(2)}
                  onBlur={() => setTitleHoverLevel(null)}
                  className={`title-level-pill title-level-pill-l2 group rounded-2xl px-7 py-4 text-center ${oxanium.className}`}
                >
                  <span className="title-level-pill-text">Level 2</span>
                </button>
              </div>

            </div>
          </section>
        </div>
      ) : null}

      {exploded ? (
        <>
          {destroyedBackgroundVisible ? (
            <div className="pointer-events-none absolute inset-0 z-[38]">
              <Image
                src={currentLevel === 1 ? "/assets/background_blowup.png" : "/assets/background_fail_2.png"}
                alt="Devastated background"
                fill
                priority
                sizes="100vw"
                className="object-cover"
              />
            </div>
          ) : null}

          {explosionFlashVisible ? <div className="pointer-events-none absolute inset-0 z-[45] bg-white/95" /> : null}

          {destroyedBackgroundVisible && !explosionFlashVisible ? (
            <div className="pointer-events-auto absolute inset-0 z-[46] flex flex-col items-center justify-center gap-6 px-4 text-center">
              <p className="text-[clamp(2.2rem,8.8vw,6.4rem)] font-black uppercase tracking-[0.2em] text-red-500 drop-shadow-[0_0_28px_rgba(239,68,68,0.95)]">
                {currentLevel === 1 ? "DEVICE DETONATED" : "MISSED THE TRAIN"}
              </p>
              <button
                type="button"
                onClick={handleRetry}
                className="animate-pulse rounded-md border border-white/40 bg-white/10 px-6 py-2 text-sm font-bold uppercase tracking-widest text-white shadow-lg backdrop-blur"
              >
                Retry
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {hasStarted && !exploded ? (
        <>
          {won ? (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-emerald-950/70">
              <div className="pointer-events-auto rounded-2xl border border-emerald-300/65 bg-emerald-500/15 px-8 py-6 text-center shadow-[0_0_45px_rgba(74,222,128,0.45)]">
                <p className="text-3xl font-black uppercase tracking-[0.18em] text-emerald-200">
                  {currentLevel === 1 ? "DEVICE DISARMED" : "GOT SUICA BACK - CAUGHT THE TRAIN"}
                </p>
                <p className="mt-2 text-sm uppercase tracking-[0.12em] text-emerald-100">Time left: {formatTime(timeRemaining)}</p>

                <div className="mt-6 flex justify-center gap-4">
                  {currentLevel === 1 ? (
                    <button
                      type="button"
                      onClick={() => startGameSequence(true, 2)}
                      className="rounded-lg border border-emerald-200/80 bg-gradient-to-b from-emerald-200 to-emerald-700 px-6 py-2 text-sm font-black uppercase tracking-[0.18em] text-emerald-950 transition hover:brightness-110"
                    >
                      Proceed to Level 2
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="rounded-lg border border-emerald-400 bg-transparent px-6 py-2 text-sm font-black uppercase tracking-[0.18em] text-emerald-200 transition hover:bg-emerald-900/50"
                  >
                    Retry
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {currentLevel === 2 && isSuicaChallengeActive && !won ? (
            <>
              <div
                className="pointer-events-none absolute right-[2vw] z-30"
                style={{ width: IC_GATE_WIDTH, bottom: IC_GATE_BOTTOM_OFFSET }}
              >
                <div
                  ref={suicaGateRef}
                  className="relative aspect-[982/1266] w-full"
                  style={{ transform: `translateY(${IC_GATE_VISUAL_Y_OFFSET})` }}
                >
                  <Image
                    src="/assets/icpassage.png"
                    alt="IC gate"
                    fill
                    priority
                    sizes="(max-width: 768px) 42vw, 42vw"
                    className="object-contain drop-shadow-[0_0_20px_rgba(56,189,248,0.35)]"
                  />
                  <div
                    ref={suicaHitboxRef}
                    className={`absolute left-[45%] top-[46.5%] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-red-500/95 bg-red-500/42 shadow-[0_0_18px_rgba(239,68,68,0.82)] ${isSuicaGateHot ? "bg-red-400/65 shadow-[0_0_22px_rgba(248,113,113,0.98)]" : ""
                      }`}
                    style={{
                      width: `${IC_GATE_HITBOX_DIAMETER_RATIO * 100}%`,
                      aspectRatio: "1 / 1"
                    }}
                  />
                </div>
              </div>

              <div
                className="pointer-events-none fixed z-[60]"
                style={{
                  left: `${suicaCursorPosition.x}px`,
                  top: `${suicaCursorPosition.y}px`,
                  transform: "translate(-50%, -50%)"
                }}
              >
                <Image
                  src="/assets/suica.png"
                  alt="Suica card cursor"
                  width={220}
                  height={140}
                  priority
                  className="h-auto w-[clamp(94px,10vw,156px)] rotate-[8deg] drop-shadow-[0_0_18px_rgba(74,222,128,0.45)]"
                />
              </div>
            </>
          ) : null}

          {currentLevel === 1 && (
            <div className="pointer-events-none absolute right-4 top-4 z-20 rounded-lg border border-cyan-300/45 bg-slate-950/70 px-3 py-2 font-mono text-sm font-black uppercase tracking-[0.16em] text-cyan-100 md:right-8 md:top-8 md:text-base">
              Stage {stage}/{LEVEL1_FINAL_STAGE}
            </div>
          )}

          {currentLevel === 1 && (
            <div className="absolute left-3 top-[58%] z-20 w-[32vw] max-w-[520px] min-w-[230px] -translate-x-[20px] -translate-y-1/2 origin-left scale-[1.2409] px-1 md:left-7 md:w-[29vw] md:px-0">
              <div className="relative mx-auto aspect-[1365/768] w-full">
                <Image
                  src="/assets/bomb2.png"
                  alt="Defuse device"
                  fill
                  priority
                  sizes="(max-width: 768px) 32vw, 29vw"
                  className="object-contain drop-shadow-[0_0_30px_rgba(248,113,113,0.42)]"
                />

                <div
                  className={`pointer-events-none absolute left-[31.2%] top-[31.8%] flex h-[19.2%] w-[33.4%] items-center justify-center transition-opacity duration-500 ${isBombTimerVisible ? "opacity-100" : "opacity-0"
                    }`}
                >
                  <span
                    className={`font-mono text-[clamp(1.02rem,2.5vw,2.45rem)] font-black tracking-[0.24em] text-red-500 drop-shadow-[0_0_18px_rgba(239,68,68,1)] ${timeRemaining <= 30 ? "animate-pulse text-red-200" : ""
                      }`}
                  >
                    {formatTime(timeRemaining)}
                  </span>
                </div>

                <div className="absolute left-[35.4%] top-[57.5%] h-[10.9%] w-[14.9%]">
                  <input
                    value={playerCodeInput}
                    onChange={(event) => {
                      const nextCode = event.target.value.replace(/\D/g, "").slice(0, 4);
                      setPlayerCodeInput(nextCode);

                      if (nextCode.length === 4 && !exploded && !won) {
                        playCodeClick();
                        setStatusLine("Verifying code...");
                        window.setTimeout(() => {
                          handleCodeSubmit(nextCode);
                        }, 70);
                      }
                    }}
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="0000"
                    disabled={exploded || won}
                    className="h-full w-full rounded-[0.32rem] border border-[#8f8a73] bg-[#d7d0ad] px-[0.22rem] text-center font-mono text-[clamp(0.56rem,1.18vw,0.95rem)] font-black tracking-[0.2em] text-slate-800 shadow-[inset_0_0_10px_rgba(15,23,42,0.18)] outline-none ring-red-500/65 transition focus:ring-2 disabled:opacity-65"
                  />
                </div>
              </div>
            </div>
          )}

          <div
            className={`relative z-20 flex h-full w-full items-end ${currentLevel === 2 ? "justify-start pl-0" : "justify-end pr-0"
              }`}
          >
            <div
              className={`relative h-[84vh] w-[48vw] min-w-[260px] max-w-[720px] transition-all duration-[1200ms] ease-out ${showCharacter ? "translate-x-0 scale-100 opacity-100" : "translate-x-10 scale-95 opacity-0"
                }`}
            >
              <Image
                src={characterImageSrc}
                alt="Phone character"
                fill
                priority
                sizes="(max-width: 768px) 70vw, 48vw"
                className={`object-contain ${currentLevel === 2 ? "object-[left_bottom]" : "object-[right_bottom]"} drop-shadow-[0_0_55px_rgba(56,189,248,0.45)] ${isNpcSpeaking ? "npc-talking-shake" : ""
                  }`}
              />

              {currentLevel === 2 && (
                <div className="pointer-events-none absolute left-[calc(35%+110px)] top-[1.2%] z-20 -translate-x-1/2 origin-top scale-[1.8] rounded-xl border border-fuchsia-300/70 bg-slate-950/80 px-4 py-2.5 font-mono text-base font-black uppercase tracking-[0.16em] text-fuchsia-100 shadow-[0_0_24px_rgba(217,70,239,0.35)] md:px-5 md:py-3 md:text-lg">
                  Last Train In: {formatTime(timeRemaining)}
                </div>
              )}

              <div
                className={`pointer-events-none absolute top-[10%] w-[min(420px,72vw)] scale-[1.452] rounded-2xl border border-cyan-300/40 bg-slate-950/80 px-4 py-3 text-left shadow-[0_0_30px_rgba(34,211,238,0.22)] backdrop-blur-sm transition-all duration-700 ${currentLevel === 2 ? "left-[54vw] origin-top-left md:left-[56vw] -translate-x-[20px]" : "left-[-48%] origin-top-left md:left-[-44%]"} ${showOpeningLine ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
                  }`}
              >
                <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-cyan-200/90">
                  <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-cyan-300" />
                  {callerName}
                </div>
                <p className="text-sm text-slate-100 md:text-base">{latestNpcLine}</p>
              </div>

              {lastTranscript && !(currentLevel === 2 && isSuicaChallengeActive) ? (
                <div className={`pointer-events-none absolute top-[54%] w-[min(420px,72vw)] scale-[1.452] rounded-xl border border-fuchsia-300/35 bg-slate-950/72 px-3 py-2 text-xs text-slate-100 backdrop-blur-sm md:text-sm ${currentLevel === 2 ? "left-[58vw] origin-top-left md:left-[60vw] -translate-x-[20px]" : "left-[-50%] origin-top-left"}`}>
                  <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-fuchsia-200/85">You (last)</p>
                  <p>{lastTranscript}</p>
                  {recognizedEmotion && recognizedEmotionVisual ? (
                    <p
                      className="mt-2 text-[11px] font-semibold uppercase tracking-[0.1em]"
                      style={{
                        color: recognizedEmotionVisual.fill,
                        WebkitTextStroke: `0.7px ${recognizedEmotionVisual.stroke}`,
                        textShadow: `0 0 8px ${recognizedEmotionVisual.glow}`
                      }}
                    >
                      You sound {EMOTION_ADJECTIVES[recognizedEmotion]} {recognizedEmotionVisual.emoji}
                      {emotionConfidencePct ? ` (${emotionConfidencePct}%)` : ""}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div
            className={`absolute left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2 transition-all duration-700 ease-out motion-reduce:transition-none ${!hasMicPrimed ? "top-[53%] -translate-y-1/2" : "bottom-5 md:bottom-6"
              } ${canTalk ? "opacity-100 scale-100" : "pointer-events-none opacity-0 scale-95"
              }`}
          >
            <button
              type="button"
              onClick={handleMicButtonClick}
              disabled={
                !hasStarted || !canTalk || exploded || won || busy || isNpcSpeaking || !recordingSupported
              }
              className={`inline-flex items-center gap-2 border font-semibold uppercase transition-all duration-500 ease-out ${canTalk && !hasMicPrimed
                  ? "rounded-xl border-2 px-8 py-4 text-base tracking-[0.22em] md:px-12 md:py-5 md:text-4xl"
                  : "rounded-md px-5 py-2 text-[11px] tracking-[0.2em] md:text-xs"
                  } ${isRecording
                    ? "border-rose-300/70 bg-rose-500/22 text-rose-100 shadow-[0_0_20px_rgba(244,63,94,0.45)]"
                    : "border-emerald-200/55 bg-black/58 text-emerald-100 shadow-[0_0_18px_rgba(16,185,129,0.28)]"
                  } disabled:cursor-not-allowed disabled:opacity-45`}
            >
              <span
                className={`inline-flex rounded-full ring-2 ${canTalk && !hasMicPrimed ? "h-4 w-4 md:h-6 md:w-6" : "h-2.5 w-2.5"
                    } ${isRecording
                      ? "animate-pulse bg-rose-500 ring-rose-200/45"
                      : "bg-emerald-400/70 ring-emerald-200/35"
                    }`}
              />
              {isRecording ? "Click to Send" : "Click to Speak"}
            </button>

            {isNpcSpeaking || busy || isRecording ? (
              <p
                className={`pointer-events-none rounded-sm bg-black/35 uppercase text-emerald-100/90 ${!hasMicPrimed
                    ? "px-4 py-1 text-sm tracking-[0.22em] md:text-xl"
                    : "px-2 py-0.5 text-[10px] tracking-[0.16em]"
                    }`}
              >
                {isNpcSpeaking ? "Caller speaking..." : busy ? "Analyzing..." : "Recording live"}
              </p>
            ) : null}
          </div>

          {micError ? (
            <p className="pointer-events-none absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-amber-500/55 bg-amber-500/20 px-3 py-2 text-xs text-amber-200 md:text-sm">
              {micError}
            </p>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
