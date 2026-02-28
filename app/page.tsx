"use client";

import Image from "next/image";
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
  emotionSource?: "huggingface" | null;
  emotionError?: string | null;
  error?: string;
}

interface TranscriptionResult {
  transcript: string;
  emotion: PlayerEmotion | null;
  emotionScore: number | null;
  emotionScores: EmotionScores | null;
  emotionModel: string | null;
  emotionSource: "huggingface" | null;
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
const OPENING_LINE = "Who is this? You have 2 minutes. Talk.";
const DARKEN_DELAY_MS = 180;
const OPENING_LINE_DELAY_MS = 980;
const TALK_READY_DELAY_MS = 1720;
const BOMB_TIMER_APPEAR_DELAY_MS = 2000;
const INTRO_TITLE = "Lie Better";
const INTRO_PROMPT = "press enter....";

const PLAYER_EMOTIONS: PlayerEmotion[] = [
  "angry",
  "disgust",
  "fear",
  "happy",
  "neutral",
  "sad",
  "surprise"
];

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

function shouldIgnoreSpaceHotkey(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || tag === "button";
}

function isSpaceKey(event: KeyboardEvent) {
  return event.code === "Space" || event.key === " " || event.key === "Spacebar";
}

export default function Home() {
  const [hasStarted, setHasStarted] = useState(false);
  const [showCharacter, setShowCharacter] = useState(false);
  const [showOpeningLine, setShowOpeningLine] = useState(false);
  const [canTalk, setCanTalk] = useState(false);

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

  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [playerCodeInput, setPlayerCodeInput] = useState("");
  const [won, setWon] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [explosionFlashVisible, setExplosionFlashVisible] = useState(false);
  const [destroyedBackgroundVisible, setDestroyedBackgroundVisible] = useState(false);
  const [isSceneShaking, setIsSceneShaking] = useState(false);
  const [isBombTimerVisible, setIsBombTimerVisible] = useState(false);

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
  const spacePttActiveRef = useRef(false);
  const audioUnlockedRef = useRef(false);

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
    const audio = new Audio("/assets/explosion_earrape.mp3");
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

  const speakNpcLine = useCallback(
    async (text: string, mood: NpcMood, suspicionLevel: number) => {
      const cleaned = text.trim();
      if (!cleaned) return;

      stopNpcVoice();
      const params = new URLSearchParams({
        text: cleaned,
        level: "1",
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
        console.info("✅  [TTS] NPC voice playback ended");
      };

      audio.onerror = (event) => {
        if (npcAudioRef.current === audio) {
          npcAudioRef.current = null;
        }
        setIsNpcSpeaking(false);
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
        setStatusLine("Browser blocked caller audio. Press Space and retry.");
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
      emotionSource: payload.emotionSource === "huggingface" ? "huggingface" : null,
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
            level: 1,
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
          setStage(clamp(Math.round(data.nextStage), 1, 5));
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
          setStatusLine("Code leaked. Enter it on the bomb panel.");
        } else if (data.shouldHangUp) {
          setStatusLine("Caller mocks you. Keep trying before the timer hits zero.");
        } else {
          const nextStage = typeof data.nextStage === "number" ? clamp(Math.round(data.nextStage), 1, 5) : stage;
          setStatusLine(`Stage ${nextStage}/5. Hold Space when ready.`);
        }

        void speakNpcLine(data.npcReply, data.npcMood, data.newSuspicion);

        if (data.shouldHangUp) {
          const reason = data.failureReason?.trim() || "Failed dialogue stage";
          console.warn("📴  [Call] Stage failed; no instant explosion mode active", { reason });
        }
      } catch (error) {
        console.error("🚨  [Turn] Evaluation error", error);
        setStatusLine("Connection glitch. Hold Space and retry.");
      } finally {
        setLoading(false);
      }
    },
    [exploded, replaceHistory, speakNpcLine, stage, suspicion, timeRemaining, timerRunning, won]
  );

  const handlePressStart = useCallback(async () => {
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
          setMicError("Audio too short. Hold Space while speaking.");
          return;
        }

        setIsTranscribing(true);
        setStatusLine("Analyzing voice...");

        try {
          const result = await transcribeBlob(audioBlob);
          if (recordingSessionRef.current !== sessionId) return;

          const shouldUseTextFallback = !result.emotion && !result.emotionError;
          const fallback = shouldUseTextFallback
            ? inferEmotionFromTranscript(result.transcript)
            : { emotion: null, score: null, scores: null };
          const finalEmotion = result.emotion ?? fallback.emotion;
          const finalEmotionScore = result.emotionScore ?? fallback.score;
          const finalEmotionScores = result.emotionScores ?? fallback.scores;
          const emotionSource = result.emotion
            ? "huggingface"
            : shouldUseTextFallback
              ? "fallback-text"
              : "none";

          if (!result.emotion && result.emotionError) {
            const friendlyError = "Emotion model unavailable. Check HF token/config on server.";
            setMicError(friendlyError);
            console.warn("⚠️  [Emotion] Hugging Face unavailable, skipping transcript fallback", {
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
          setStatusLine("Mic/transcription issue. Hold Space to retry.");
        } finally {
          if (recordingSessionRef.current === sessionId) {
            setIsTranscribing(false);
          }
        }
      };

      recorder.start();
      setIsRecording(true);
      setStatusLine("Recording... release Space to send.");
      console.info("🎙️  [Audio] Recording started");
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

  const handlePressEnd = useCallback(() => {
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
      setStatusLine("DEVICE DISARMED");
      console.info("✅  [Bomb] Correct code, device disarmed", { code: attemptedCode, timeRemaining });
      return;
    }

    setStatusLine("Wrong code. Try again before timer ends.");
    console.warn("⚠️  [Bomb] Wrong code, no instant explosion (timer remains the only fail condition).");
  }, [exploded, playerCodeInput, revealedCode, timeRemaining, won]);

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

  const startGameSequence = useCallback((forceRestart: boolean = false) => {
    if (hasStarted && !forceRestart) return;

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

    replaceHistory([]);
    setHasStarted(true);
    setShowCharacter(false);
    setShowOpeningLine(false);
    setCanTalk(false);
    setTimerRunning(false);
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
      replaceHistory([{ role: "npc", content: OPENING_LINE }]);
      setTimerRunning(true);
      setStatusLine("Unknown Caller is speaking...");
      void speakNpcLine(OPENING_LINE, "suspicious", START_SUSPICION);
      console.info("📞  [Intro] Opening line displayed, timer started");
    }, OPENING_LINE_DELAY_MS);

    talkReadyTimeoutRef.current = window.setTimeout(() => {
      setCanTalk(true);
      setStatusLine("Hold Space to respond");
      console.info("⌨️  [Intro] Space hold-to-talk enabled");
    }, TALK_READY_DELAY_MS);
  }, [
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
    startGameSequence(true);
  }, [startGameSequence]);

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
    if (hasStarted) return;

    const onEnterDown = (event: KeyboardEvent) => {
      if (event.code !== "Enter") return;
      if (shouldIgnoreSpaceHotkey(event.target)) return;
      event.preventDefault();
      void startGameSequence();
    };

    window.addEventListener("keydown", onEnterDown);

    return () => {
      window.removeEventListener("keydown", onEnterDown);
    };
  }, [hasStarted, startGameSequence]);

  useEffect(() => {
    if (!exploded) return;

    const onEnterRetry = (event: KeyboardEvent) => {
      if (event.code !== "Enter") return;
      if (shouldIgnoreSpaceHotkey(event.target)) return;
      event.preventDefault();
      handleRetry();
    };

    window.addEventListener("keydown", onEnterRetry);

    return () => {
      window.removeEventListener("keydown", onEnterRetry);
    };
  }, [exploded, handleRetry]);

  useEffect(() => {
    if (!hasStarted || !canTalk || exploded || won) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSpaceKey(event)) return;
      event.preventDefault();

      // Fallback for environments where keyup is swallowed (e.g. remote desktop):
      // a new non-repeated space press while recording force-stops recording.
      if (!event.repeat && spacePttActiveRef.current && isRecording) {
        spacePttActiveRef.current = false;
        handlePressEnd();
        return;
      }

      if (event.repeat || spacePttActiveRef.current) return;

      spacePttActiveRef.current = true;
      void handlePressStart();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!isSpaceKey(event)) return;
      if (!spacePttActiveRef.current) return;

      event.preventDefault();
      spacePttActiveRef.current = false;
      handlePressEnd();
    };

    const onBlur = () => {
      if (!spacePttActiveRef.current) return;
      spacePttActiveRef.current = false;
      handlePressEnd();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      spacePttActiveRef.current = false;
    };
  }, [canTalk, exploded, handlePressEnd, handlePressStart, hasStarted, isRecording, won]);

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
    if (!exploded) return;

    void unlockAudioPlayback();
    void playExplosionSound();
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
  }, [exploded, playExplosionSound, unlockAudioPlayback]);

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
    };
  }, [clearIntroSequenceTimers, releaseMicrophone, stopExplosionSound, stopNpcVoice, stopRecording]);

  const latestNpcLine = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === "npc") return history[i].content;
    }
    return OPENING_LINE;
  }, [history]);

  const characterImageSrc = useMemo(() => {
    if (revealedCode) return "/assets/defeat.png";
    const playerTurns = history.filter((line) => line.role === "player").length;
    return playerTurns >= 2 ? "/assets/angrycat.png" : "/assets/cat2.png";
  }, [history, revealedCode]);

  const topEmotionDetail = useMemo(() => {
    if (!lastEmotionScores) return null;

    const entries = Object.entries(lastEmotionScores) as Array<[PlayerEmotion, number]>;
    entries.sort((a, b) => b[1] - a[1]);
    const [emotion, score] = entries[0] ?? [null, 0];
    if (!emotion || !Number.isFinite(score) || score <= 0) return null;
    return { emotion, score };
  }, [lastEmotionScores]);

  return (
    <main className={`relative h-screen w-screen overflow-hidden select-none ${isSceneShaking ? "explode-shake" : ""}`}>
      <div
        className={`pointer-events-none absolute inset-0 bg-black transition-opacity duration-[1400ms] ease-out ${
          hasStarted && !destroyedBackgroundVisible ? "opacity-60" : "opacity-0"
        }`}
      />

      {!hasStarted ? (
        <button
          type="button"
          onClick={() => startGameSequence()}
          className="absolute inset-0 z-30 flex items-center justify-center focus:outline-none"
          aria-label="Start game"
        >
          <div className="pointer-events-none relative overflow-hidden rounded-3xl border border-cyan-100/65 bg-black/88 px-7 py-6 text-center shadow-[0_0_75px_rgba(34,211,238,0.4)] backdrop-blur-[3px] md:px-12 md:py-9">
            <div className="absolute inset-0 bg-gradient-to-b from-slate-950/55 via-black/70 to-black/85" />
            <div className="relative z-10">
              <h1 className="text-5xl font-black uppercase tracking-[0.24em] text-white drop-shadow-[0_0_26px_rgba(165,243,252,0.9)] md:text-7xl">
                {INTRO_TITLE}
              </h1>
              <p className="mt-5 animate-pulse text-sm font-semibold tracking-[0.32em] text-white/90 md:text-lg">
                {INTRO_PROMPT}
              </p>
            </div>
          </div>
        </button>
      ) : null}

      {exploded ? (
        <>
          {destroyedBackgroundVisible ? (
            <div className="pointer-events-none absolute inset-0 z-[38]">
              <Image
                src="/assets/background_blowup.png"
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
            <p className="pointer-events-none absolute bottom-7 left-1/2 z-[46] -translate-x-1/2 animate-pulse rounded-md border border-red-100/55 bg-black/58 px-4 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-red-50 md:bottom-9 md:text-sm">
              Press Enter to Retry
            </p>
          ) : null}
        </>
      ) : null}

      {hasStarted && !exploded ? (
        <>
          {won ? (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-emerald-950/70">
              <div className="rounded-2xl border border-emerald-300/65 bg-emerald-500/15 px-8 py-6 text-center shadow-[0_0_45px_rgba(74,222,128,0.45)]">
                <p className="text-3xl font-black uppercase tracking-[0.18em] text-emerald-200">DEVICE DISARMED</p>
                <p className="mt-2 text-sm uppercase tracking-[0.12em] text-emerald-100">Time left: {formatTime(timeRemaining)}</p>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="mt-5 rounded-lg border border-emerald-200/80 bg-gradient-to-b from-emerald-200 to-emerald-700 px-6 py-2 text-sm font-black uppercase tracking-[0.18em] text-emerald-950 transition hover:brightness-110"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-cyan-300/35 bg-slate-950/55 px-4 py-2 font-mono text-xl font-bold text-cyan-200 md:left-8 md:top-8 md:text-3xl">
            Suspicion {suspicion} • {npcMood} • Stage {stage}/5
            <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-100/80 md:text-xs">{statusLine}</p>
          </div>

          <div className="absolute left-3 top-[58%] z-20 w-[32vw] max-w-[520px] min-w-[230px] -translate-y-1/2 px-1 md:left-7 md:w-[29vw] md:px-0">
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
                className={`pointer-events-none absolute left-[31.2%] top-[31.8%] flex h-[19.2%] w-[33.4%] items-center justify-center transition-opacity duration-500 ${
                  isBombTimerVisible ? "opacity-100" : "opacity-0"
                }`}
              >
                <span
                  className={`font-mono text-[clamp(1.02rem,2.5vw,2.45rem)] font-black tracking-[0.24em] text-red-500 drop-shadow-[0_0_18px_rgba(239,68,68,1)] ${
                    timeRemaining <= 30 ? "animate-pulse text-red-200" : ""
                  }`}
                >
                  {formatTime(timeRemaining)}
                </span>
              </div>

              <div className="absolute left-[38.35%] top-[62.45%] h-[10.9%] w-[14.9%]">
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

          <div className="relative flex h-full w-full items-end justify-end pr-3 md:pr-10 lg:pr-16">
            <div
              className={`relative h-[84vh] w-[48vw] min-w-[260px] max-w-[720px] transition-all duration-[1200ms] ease-out ${
                showCharacter ? "translate-x-0 scale-100 opacity-100" : "translate-x-10 scale-95 opacity-0"
              }`}
            >
              <Image
                src={characterImageSrc}
                alt="Phone character"
                fill
                priority
                sizes="(max-width: 768px) 70vw, 48vw"
                className="object-contain object-right drop-shadow-[0_0_55px_rgba(56,189,248,0.45)]"
              />

              <div
                className={`pointer-events-none absolute left-[-48%] top-[10%] w-[min(420px,72vw)] rounded-2xl border border-cyan-300/40 bg-slate-950/80 px-4 py-3 text-left shadow-[0_0_30px_rgba(34,211,238,0.22)] backdrop-blur-sm transition-all duration-700 md:left-[-44%] ${
                  showOpeningLine ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
                }`}
              >
                <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-cyan-200/90">
                  <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-cyan-300" />
                  Unknown Caller
                </div>
                <p className="text-sm text-slate-100 md:text-base">{latestNpcLine}</p>
              </div>

              <div
                className={`pointer-events-none absolute bottom-[2%] left-[-40%] rounded-lg border border-emerald-300/35 bg-emerald-500/10 px-3 py-2 text-xs uppercase tracking-[0.12em] text-emerald-200 transition-all duration-700 md:bottom-[3%] ${
                  canTalk ? "opacity-100" : "opacity-0"
                }`}
              >
                {isNpcSpeaking
                  ? "Caller speaking..."
                  : isRecording
                    ? "Recording... release Space"
                    : busy
                      ? "Analyzing..."
                      : "Hold Space to Talk"}
              </div>

              {lastTranscript ? (
                <div className="pointer-events-none absolute left-[-50%] top-[54%] w-[min(420px,72vw)] rounded-xl border border-fuchsia-300/35 bg-slate-950/72 px-3 py-2 text-xs text-slate-100 backdrop-blur-sm md:text-sm">
                  <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-fuchsia-200/85">You (last)</p>
                  <p>{lastTranscript}</p>
                  {lastEmotion ? (
                    <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-amber-300/95">
                      Emotion: {lastEmotion}
                      {typeof lastEmotionScore === "number" ? ` (${Math.round(lastEmotionScore * 100)}%)` : ""}
                    </p>
                  ) : null}
                  {topEmotionDetail ? (
                    <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-cyan-300/95">
                      Top score: {topEmotionDetail.emotion} ({Math.round(topEmotionDetail.score * 100)}%)
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
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
