"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { CodeEntry } from "@/app/components/CodeEntry";
import { ConversationLog } from "@/app/components/ConversationLog";
import { Meters } from "@/app/components/Meters";
import { PushToTalk } from "@/app/components/PushToTalk";
import { StatusPill } from "@/app/components/StatusPill";
import type { HistoryItem, NpcMood } from "@/app/components/types";

type GameStatus = "idle" | "playing" | "won" | "lost";
type LoseReason = "CALL ENDED" | "TIME OUT" | null;
type LevelId = 1 | 2;
type PlayerEmotion = "angry" | "disgust" | "fear" | "happy" | "neutral" | "sad" | "surprise";
type EmotionScores = Record<PlayerEmotion, number>;

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
}

interface TranscribeResponse {
  transcript?: string;
  emotion?: PlayerEmotion | null;
  emotionScore?: number | null;
  emotionScores?: Partial<Record<PlayerEmotion, number>> | null;
  error?: string;
}

interface TranscriptionResult {
  transcript: string;
  emotion: PlayerEmotion | null;
  emotionScore: number | null;
  emotionScores: EmotionScores | null;
}

interface NpcSpeechProfile {
  suspicion: number;
  mood: NpcMood;
}

interface LevelMeta {
  title: string;
  npcName: string;
  intro: string;
  objective: string;
  hint: string;
  visualHint: string;
}

const LEVELS: Record<LevelId, LevelMeta> = {
  1: {
    title: "Level 1 · Cornered Villain",
    npcName: "Viktor Raze",
    intro: "Who is this? You get 120 seconds. Say something useful.",
    objective: "Break his confidence. Threat pressure makes him crack.",
    hint: "He acts hard, but fear wins if you push him.",
    visualHint: "Future slot: hostile criminal portrait with fear micro-expressions."
  },
  2: {
    title: "Level 2 · Plush Firewall Cat",
    npcName: "Mochi",
    intro: "Mrrp? Wrong number... unless you bring pets and cozy vibes.",
    objective: "Only affection unlocks the code. Threats make Mochi bail.",
    hint: "Mention petting, pats, caresses, cuddles.",
    visualHint: "Future slot: cute cat portrait with calm/suspicious facial states."
  }
};

const START_TIME = 120;
const START_SUSPICION = 50;
const PLAYER_EMOTIONS: PlayerEmotion[] = [
  "angry",
  "disgust",
  "fear",
  "happy",
  "neutral",
  "sad",
  "surprise"
];
const TV_NEWS_TICKER =
  "BBC NEWS ALERT ALERT • DEVICE CRISIS LIVE • GOLDEN gAI EXCLUSIVE • HIGH-PRESSURE CALL IN PROGRESS •";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function moodFromSuspicion(value: number): NpcMood {
  if (value >= 75) return "hostile";
  if (value >= 40) return "suspicious";
  return "calm";
}

function pickSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4"
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
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

  let hasValue = false;
  for (const emotion of PLAYER_EMOTIONS) {
    const raw = Number(source[emotion]);
    if (!Number.isFinite(raw)) continue;
    scores[emotion] = clamp(raw, 0, 1);
    if (raw > 0) hasValue = true;
  }

  return hasValue ? scores : null;
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

function shouldIgnoreSpaceHotkey(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || tag === "button";
}

export default function Home() {
  const [currentLevel, setCurrentLevel] = useState<LevelId>(1);
  const [gameStatus, setGameStatus] = useState<GameStatus>("idle");
  const [timeRemaining, setTimeRemaining] = useState<number>(START_TIME);
  const [suspicion, setSuspicion] = useState<number>(START_SUSPICION);
  const [npcMood, setNpcMood] = useState<NpcMood>("suspicious");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [playerCodeInput, setPlayerCodeInput] = useState<string>("");
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isLiveSyncing, setIsLiveSyncing] = useState<boolean>(false);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [lastEmotion, setLastEmotion] = useState<PlayerEmotion | null>(null);
  const [lastEmotionScore, setLastEmotionScore] = useState<number | null>(null);
  const [lastEmotionScores, setLastEmotionScores] = useState<EmotionScores | null>(null);
  const [faceEmotion, setFaceEmotion] = useState<PlayerEmotion | null>(null);
  const [faceEmotionScore, setFaceEmotionScore] = useState<number | null>(null);
  const [faceEmotionScores, setFaceEmotionScores] = useState<EmotionScores | null>(null);
  const [webcamSupported, setWebcamSupported] = useState<boolean>(false);
  const [webcamEnabled, setWebcamEnabled] = useState<boolean>(false);
  const [webcamError, setWebcamError] = useState<string>("");
  const [, setLiveTranscript] = useState<string>("");
  const [, setDraftTranscript] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [recordingSupported, setRecordingSupported] = useState<boolean>(false);
  const [micError, setMicError] = useState<string>("");
  const [loseReason, setLoseReason] = useState<LoseReason>(null);
  const [flashLoss, setFlashLoss] = useState<boolean>(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef<boolean>(false);
  const recordingSessionRef = useRef<number>(0);
  const partialInFlightRef = useRef<boolean>(false);
  const partialLastRunAtRef = useRef<number>(0);
  const npcAudioRef = useRef<HTMLAudioElement | null>(null);
  const npcAudioUrlRef = useRef<string | null>(null);
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const thinkingPulseIntervalRef = useRef<number | null>(null);
  const thinkingPulseTimeoutRef = useRef<number | null>(null);
  const thinkingAudioContextRef = useRef<AudioContext | null>(null);
  const ttsTokenRef = useRef<number>(0);
  const spacePttActiveRef = useRef<boolean>(false);

  const levelMeta = LEVELS[currentLevel];
  const busy = loading || isTranscribing;
  const isDanger = gameStatus === "playing" && timeRemaining < 30;

  const releaseMicrophone = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const stopWebcam = useCallback(() => {
    const stream = webcamStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      webcamStreamRef.current = null;
    }

    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
    }

    setWebcamEnabled(false);
  }, []);

  const startWebcam = useCallback(async () => {
    if (!webcamSupported || gameStatus !== "playing") return;

    try {
      if (webcamStreamRef.current) {
        if (webcamVideoRef.current && webcamVideoRef.current.srcObject !== webcamStreamRef.current) {
          webcamVideoRef.current.srcObject = webcamStreamRef.current;
          void webcamVideoRef.current.play().catch(() => {
            // Ignore autoplay policy issues.
          });
        }
        setWebcamEnabled(true);
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      webcamStreamRef.current = stream;
      if (webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = stream;
        void webcamVideoRef.current.play().catch(() => {
          // Ignore autoplay policy issues.
        });
      }

      setWebcamError("");
      setWebcamEnabled(true);
      console.info("📹  [Webcam] User webcam ready (zoom feed active)");
    } catch (error) {
      console.warn("⚠️  [Webcam] Unable to start webcam", error);
      setWebcamEnabled(false);
      setWebcamError("Webcam unavailable or permission denied.");
    }
  }, [gameStatus, webcamSupported]);

  const stopRecording = useCallback((discard: boolean = false) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      setIsRecording(false);
      setIsLiveSyncing(false);
      return;
    }

    if (recorder.state === "recording") {
      discardRecordingRef.current = discard;
      try {
        recorder.stop();
      } catch {
        // Ignore recorder stop errors.
      }
    } else {
      setIsRecording(false);
      setIsLiveSyncing(false);
    }
  }, []);

  const stopNpcVoice = useCallback(() => {
    ttsTokenRef.current += 1;

    const audio = npcAudioRef.current;
    if (audio) {
      try {
        audio.pause();
        audio.src = "";
      } catch {
        // Ignore audio cleanup errors.
      }
      npcAudioRef.current = null;
    }

    if (npcAudioUrlRef.current) {
      URL.revokeObjectURL(npcAudioUrlRef.current);
      npcAudioUrlRef.current = null;
    }
  }, []);

  const stopThinkingPulse = useCallback(() => {
    if (thinkingPulseIntervalRef.current !== null) {
      window.clearInterval(thinkingPulseIntervalRef.current);
      thinkingPulseIntervalRef.current = null;
    }
    if (thinkingPulseTimeoutRef.current !== null) {
      window.clearTimeout(thinkingPulseTimeoutRef.current);
      thinkingPulseTimeoutRef.current = null;
    }
  }, []);

  const playThinkingPulse = useCallback(() => {
    if (typeof window === "undefined") return;

    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    if (!thinkingAudioContextRef.current) {
      thinkingAudioContextRef.current = new AudioContextCtor();
    }

    const ctx = thinkingAudioContextRef.current;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {
        // Ignore resume failures (autoplay policies).
      });
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(620, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.02, ctx.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  }, []);

  const startThinkingPulse = useCallback(() => {
    if (thinkingPulseIntervalRef.current !== null) return;

    playThinkingPulse();
    thinkingPulseIntervalRef.current = window.setInterval(() => {
      playThinkingPulse();
    }, 620);

    thinkingPulseTimeoutRef.current = window.setTimeout(() => {
      stopThinkingPulse();
    }, 7000);
  }, [playThinkingPulse, stopThinkingPulse]);

  const speakNpcLine = useCallback(
    async (content: string, level: LevelId, profile?: NpcSpeechProfile) => {
      if (level !== 1) return;

      const text = content.trim();
      if (!text) return;

      const suspicionForVoice = clamp(profile?.suspicion ?? suspicion, 0, 100);
      const moodForVoice: NpcMood = profile?.mood ?? npcMood;

      // Stop previous NPC audio first. This increments token to invalidate any old in-flight TTS request.
      stopNpcVoice();
      const token = ttsTokenRef.current + 1;
      ttsTokenRef.current = token;
      startThinkingPulse();

      try {
        const response = await fetch("/api/tts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            text: text.slice(0, 260),
            level: 1,
            suspicion: suspicionForVoice,
            mood: moodForVoice
          })
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || "TTS request failed.");
        }

        const audioBlob = await response.blob();
        if (!audioBlob.size) {
          throw new Error("TTS returned empty audio.");
        }

        if (token !== ttsTokenRef.current) {
          console.info("🔇  [TTS] Ignoring stale TTS response (token mismatch)");
          return;
        }

        const audioUrl = URL.createObjectURL(audioBlob);
        npcAudioUrlRef.current = audioUrl;
        const audio = new Audio(audioUrl);
        audio.preload = "auto";

        audio.oncanplay = () => {
          if (token === ttsTokenRef.current) {
            stopThinkingPulse();
          }
        };

        audio.onplaying = () => {
          if (token === ttsTokenRef.current) {
            stopThinkingPulse();
          }
        };

        audio.onended = () => {
          if (npcAudioRef.current === audio) {
            npcAudioRef.current = null;
          }
          if (npcAudioUrlRef.current === audioUrl) {
            URL.revokeObjectURL(audioUrl);
            npcAudioUrlRef.current = null;
          }
          stopThinkingPulse();
        };

        audio.onerror = () => {
          if (npcAudioRef.current === audio) {
            npcAudioRef.current = null;
          }
          if (npcAudioUrlRef.current === audioUrl) {
            URL.revokeObjectURL(audioUrl);
            npcAudioUrlRef.current = null;
          }
          stopThinkingPulse();
        };

        if (token !== ttsTokenRef.current) {
          console.info("🔇  [TTS] Ignoring stale TTS audio before play (token mismatch)");
          return;
        }
        npcAudioRef.current = audio;
        await audio.play();
        console.info("🔊  [TTS] Level 1 NPC voice started");
      } catch (error) {
        console.warn("⚠️  [TTS] NPC voice skipped", error);
        stopThinkingPulse();
      }
    },
    [npcMood, startThinkingPulse, stopNpcVoice, stopThinkingPulse, suspicion]
  );

  const pushNpcLine = useCallback(
    (
      content: string,
      options?: {
        level?: LevelId;
        speechProfile?: NpcSpeechProfile;
      }
    ) => {
      const level = options?.level ?? currentLevel;
      setHistory((prev) => [...prev, { role: "npc", content }]);
      if (level === 1) {
        void speakNpcLine(content, level, options?.speechProfile);
      }
    },
    [currentLevel, speakNpcLine]
  );

  const triggerLoss = useCallback(
    (reason: Exclude<LoseReason, null>) => {
      stopRecording(true);
      stopNpcVoice();
      stopThinkingPulse();
      setLoading(false);
      setIsTranscribing(false);
      setIsLiveSyncing(false);
      setGameStatus("lost");
      setLoseReason(reason);
      setFlashLoss(true);
      setTimeout(() => setFlashLoss(false), 900);
    },
    [stopNpcVoice, stopRecording, stopThinkingPulse]
  );

  const submitTurn = useCallback(
    async (
      rawTranscript: string,
      playerEmotion: PlayerEmotion | null = null,
      emotionScore: number | null = null
    ) => {
      const transcript = rawTranscript.trim();
      if (!transcript || gameStatus !== "playing" || loading) return;

      setLoading(true);
      setLastTranscript(transcript);
      setDraftTranscript(transcript);
      setMicError("");

      const playerLine: HistoryItem = { role: "player", content: transcript };
      const historyForEval = [...history, playerLine];
      const round = historyForEval.filter((line) => line.role === "player").length;

      setHistory(historyForEval);

      try {
        const response = await fetch("/api/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript,
            timeRemaining,
            suspicion,
            history: historyForEval,
            round,
            level: currentLevel,
            playerEmotion,
            emotionScore
          })
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? "Failed to evaluate transcript.");
        }

        const data = (await response.json()) as EvaluateResponse;

        pushNpcLine(data.npcReply, {
          level: currentLevel,
          speechProfile: {
            suspicion: data.newSuspicion,
            mood: data.npcMood
          }
        });
        setSuspicion(clamp(data.newSuspicion, 0, 100));
        setNpcMood(data.npcMood);

        if (data.revealCode && data.code) {
          setRevealedCode(data.code);
        }

        if (data.shouldHangUp) {
          triggerLoss("CALL ENDED");
        }
      } catch (error) {
        console.error("🚨  [Game] Evaluation failed", error);
        const fallbackSuspicion = clamp(suspicion + 4, 0, 100);
        setSuspicion(fallbackSuspicion);
        setNpcMood(moodFromSuspicion(fallbackSuspicion));
        pushNpcLine(
          currentLevel === 2
            ? "Mrrp... static noise. Say it again, clearly."
            : "Line is breaking. You're sounding uncertain. Speak clearly.",
          {
            level: currentLevel,
            speechProfile: {
              suspicion: fallbackSuspicion,
              mood: moodFromSuspicion(fallbackSuspicion)
            }
          }
        );
        if (fallbackSuspicion >= 85) {
          triggerLoss("CALL ENDED");
        }
      } finally {
        setLoading(false);
      }
    },
    [
      currentLevel,
      gameStatus,
      history,
      loading,
      pushNpcLine,
      suspicion,
      timeRemaining,
      triggerLoss
    ]
  );

  const transcribeBlob = useCallback(
    async (audioBlob: Blob, analyzeEmotion: boolean): Promise<TranscriptionResult> => {
      const ext = audioBlob.type.includes("ogg")
        ? "ogg"
        : audioBlob.type.includes("mp4")
          ? "mp4"
          : "webm";

      const file = new File([audioBlob], `turn-${Date.now()}.${ext}`, {
        type: audioBlob.type || "audio/webm"
      });

      const formData = new FormData();
      formData.append("audio", file);
      formData.append("language", "en");
      formData.append("analyzeEmotion", analyzeEmotion ? "1" : "0");

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
        emotionScores: parseEmotionScores(payload.emotionScores)
      };
    },
    []
  );

  const requestPartialTranscription = useCallback(
    async (sessionId: number) => {
      if (partialInFlightRef.current || gameStatus !== "playing" || !isRecording) return;

      const now = Date.now();
      if (now - partialLastRunAtRef.current < 900) return;

      const recorder = mediaRecorderRef.current;
      if (!recorder) return;

      const blob = new Blob(audioChunksRef.current, {
        type: recorder.mimeType || "audio/webm"
      });

      if (blob.size < 2000) return;

      partialInFlightRef.current = true;
      partialLastRunAtRef.current = now;
      setIsLiveSyncing(true);

      try {
        const { transcript } = await transcribeBlob(blob, false);
        if (recordingSessionRef.current !== sessionId || gameStatus !== "playing" || !isRecording) {
          return;
        }
        setLiveTranscript(transcript);
        setDraftTranscript(transcript);
      } catch (error) {
        console.warn("⚠️  [Audio] Live transcript sync skipped", error);
      } finally {
        if (recordingSessionRef.current === sessionId) {
          setIsLiveSyncing(false);
        }
        partialInFlightRef.current = false;
      }
    },
    [gameStatus, isRecording, transcribeBlob]
  );

  const finalizeRecording = useCallback(
    async (audioBlob: Blob, sessionId: number) => {
      if (gameStatus !== "playing") return;

      setIsTranscribing(true);
      setIsLiveSyncing(false);
      setMicError("");

      try {
        const { transcript, emotion, emotionScore, emotionScores } = await transcribeBlob(
          audioBlob,
          true
        );
        if (recordingSessionRef.current !== sessionId || gameStatus !== "playing") return;

        setLiveTranscript(transcript);
        setDraftTranscript(transcript);
        setLastEmotion(emotion);
        setLastEmotionScore(emotionScore);
        setLastEmotionScores(emotionScores);
        await submitTurn(transcript, emotion, emotionScore);
      } catch (error) {
        console.error("🚨  [Game] Final transcription failed", error);
        setMicError("Could not transcribe audio. Try recording again.");
      } finally {
        if (recordingSessionRef.current === sessionId) {
          setIsTranscribing(false);
        }
      }
    },
    [gameStatus, submitTurn, transcribeBlob]
  );

  const startLevel = useCallback(
    (level: LevelId) => {
      stopRecording(true);
      stopNpcVoice();
      setCurrentLevel(level);
      setGameStatus("playing");
      setTimeRemaining(START_TIME);
      setSuspicion(START_SUSPICION);
      setNpcMood("suspicious");
      const intro = LEVELS[level].intro;
      setHistory([{ role: "npc", content: intro }]);
      if (level === 1) {
        void speakNpcLine(intro, level, {
          suspicion: START_SUSPICION,
          mood: "suspicious"
        });
      }
      setRevealedCode(null);
      setPlayerCodeInput("");
      setLastTranscript("");
      setLastEmotion(null);
      setLastEmotionScore(null);
      setLastEmotionScores(null);
      setFaceEmotion(null);
      setFaceEmotionScore(null);
      setFaceEmotionScores(null);
      setWebcamError("");
      setLiveTranscript("");
      setDraftTranscript("");
      setMicError("");
      setLoseReason(null);
      setLoading(false);
      setIsTranscribing(false);
      setIsLiveSyncing(false);
      setFlashLoss(false);
    },
    [speakNpcLine, stopNpcVoice, stopRecording]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const hasGetUserMedia =
      !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";
    const hasMediaRecorder = typeof window.MediaRecorder !== "undefined" && hasGetUserMedia;

    setRecordingSupported(hasMediaRecorder);
    setWebcamSupported(hasGetUserMedia);
  }, []);

  useEffect(() => {
    if (gameStatus !== "playing") {
      stopWebcam();
      setFaceEmotion(null);
      setFaceEmotionScore(null);
      setFaceEmotionScores(null);
      return;
    }

    if (webcamSupported && !webcamEnabled) {
      void startWebcam();
    }
  }, [gameStatus, startWebcam, stopWebcam, webcamEnabled, webcamSupported]);

  useEffect(() => {
    if (gameStatus !== "playing" || !webcamEnabled) return;

    // Placeholder hook for future face-model inference loop.
    // Next step: capture frames and call a face-emotion endpoint/model.
    const interval = window.setInterval(() => {
      // Keep a stable baseline signal so the blend panel can show a voice+face structure.
      setFaceEmotion((current) => current ?? "neutral");
      setFaceEmotionScore((current) => current ?? 0.34);
      setFaceEmotionScores((current) => current ?? mapSingleEmotionScore("neutral", 0.34));
    }, 1500);

    return () => window.clearInterval(interval);
  }, [gameStatus, webcamEnabled]);

  useEffect(() => {
    if (gameStatus !== "playing") return;

    const interval = setInterval(() => {
      setTimeRemaining((prev) => Math.max(prev - 1, 0));
    }, 1000);

    return () => clearInterval(interval);
  }, [gameStatus]);

  useEffect(() => {
    if (gameStatus === "playing" && timeRemaining <= 0) {
      triggerLoss("TIME OUT");
    }
  }, [gameStatus, timeRemaining, triggerLoss]);

  useEffect(() => {
    return () => {
      stopRecording(true);
      stopNpcVoice();
      stopThinkingPulse();
      releaseMicrophone();
      stopWebcam();
      if (thinkingAudioContextRef.current) {
        void thinkingAudioContextRef.current.close().catch(() => {
          // Ignore close failures.
        });
        thinkingAudioContextRef.current = null;
      }
    };
  }, [releaseMicrophone, stopNpcVoice, stopRecording, stopThinkingPulse, stopWebcam]);

  const handleResetToIdle = () => {
    stopRecording(true);
    stopNpcVoice();
    stopThinkingPulse();
    releaseMicrophone();
    stopWebcam();
    setCurrentLevel(1);
    setGameStatus("idle");
    setTimeRemaining(START_TIME);
    setSuspicion(START_SUSPICION);
    setNpcMood("suspicious");
    setHistory([]);
    setRevealedCode(null);
    setPlayerCodeInput("");
    setLastTranscript("");
    setLastEmotion(null);
    setLastEmotionScore(null);
    setLastEmotionScores(null);
    setFaceEmotion(null);
    setFaceEmotionScore(null);
    setFaceEmotionScores(null);
    setWebcamError("");
    setLiveTranscript("");
    setDraftTranscript("");
    setMicError("");
    setLoseReason(null);
    setLoading(false);
    setIsTranscribing(false);
    setIsLiveSyncing(false);
    setFlashLoss(false);
  };

  const handlePressStart = useCallback(async () => {
    if (!recordingSupported || gameStatus !== "playing" || busy || isRecording) return;

    stopNpcVoice();
    stopThinkingPulse();
    setLiveTranscript("");
    setDraftTranscript("");
    setMicError("");
    partialLastRunAtRef.current = 0;
    partialInFlightRef.current = false;

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
          void requestPartialTranscription(sessionId);
        }
      };

      recorder.onerror = (event) => {
        console.error("🚨  [Audio] Recorder error", event);
        setMicError("Microphone recorder failed. Retry recording.");
        setIsRecording(false);
        setIsLiveSyncing(false);
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        setIsLiveSyncing(false);
        partialInFlightRef.current = false;
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
          setMicError("Audio too short. Hold the button while speaking.");
          return;
        }

        await finalizeRecording(audioBlob, sessionId);
      };

      recorder.start(250);
      setIsRecording(true);
      console.info("🎙️  [Audio] Recording started");
    } catch (error) {
      console.error("🚨  [Audio] Unable to start recording", error);
      setMicError("Microphone access denied or unavailable.");
      setIsRecording(false);
    }
  }, [
    busy,
    finalizeRecording,
    gameStatus,
    isRecording,
    recordingSupported,
    requestPartialTranscription,
    stopNpcVoice,
    stopThinkingPulse
  ]);

  const handlePressEnd = useCallback(() => {
    if (!isRecording) return;
    stopRecording(false);
  }, [isRecording, stopRecording]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (shouldIgnoreSpaceHotkey(event.target)) return;

      if (event.repeat || spacePttActiveRef.current) {
        event.preventDefault();
        return;
      }

      if (!recordingSupported || gameStatus !== "playing" || busy) return;

      event.preventDefault();
      spacePttActiveRef.current = true;
      void handlePressStart();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (!spacePttActiveRef.current) return;

      event.preventDefault();
      spacePttActiveRef.current = false;
      handlePressEnd();
    };

    const onWindowBlur = () => {
      if (!spacePttActiveRef.current) return;
      spacePttActiveRef.current = false;
      handlePressEnd();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      spacePttActiveRef.current = false;
    };
  }, [busy, gameStatus, handlePressEnd, handlePressStart, recordingSupported]);

  const handleDefuse = () => {
    if (gameStatus !== "playing" || !revealedCode) return;

    if (playerCodeInput === revealedCode) {
      stopRecording(true);
      stopNpcVoice();
      setGameStatus("won");
      setLoseReason(null);
      pushNpcLine(
        currentLevel === 1
          ? "You win this round. I'm out."
          : "Purrfect! Device is safe. You may pet the cat.",
        {
          level: currentLevel,
          speechProfile: {
            suspicion,
            mood: npcMood
          }
        }
      );
      return;
    }

    const raisedSuspicion = clamp(suspicion + 8, 0, 100);
    setSuspicion(raisedSuspicion);
    setNpcMood(moodFromSuspicion(raisedSuspicion));
    setPlayerCodeInput("");
    pushNpcLine(
      currentLevel === 2
        ? "Mrrrp? Wrong code. Less panic, more gentle vibes."
        : "Wrong code. You're guessing. Why should I trust you?",
      {
        level: currentLevel,
        speechProfile: {
          suspicion: raisedSuspicion,
          mood: moodFromSuspicion(raisedSuspicion)
        }
      }
    );

    if (raisedSuspicion >= 85) {
      triggerLoss("CALL ENDED");
    }
  };

  const voiceScoreMap = useMemo(
    () => lastEmotionScores ?? mapSingleEmotionScore(lastEmotion, lastEmotionScore),
    [lastEmotion, lastEmotionScore, lastEmotionScores]
  );

  const faceScoreMap = useMemo(
    () => faceEmotionScores ?? mapSingleEmotionScore(faceEmotion, faceEmotionScore),
    [faceEmotion, faceEmotionScore, faceEmotionScores]
  );

  const blendedEmotionScores = useMemo(() => {
    if (!voiceScoreMap && !faceScoreMap) return null;

    const merged: EmotionScores = {
      angry: 0,
      disgust: 0,
      fear: 0,
      happy: 0,
      neutral: 0,
      sad: 0,
      surprise: 0
    };

    for (const emotion of PLAYER_EMOTIONS) {
      const voice = voiceScoreMap?.[emotion] ?? 0;
      const face = faceScoreMap?.[emotion] ?? 0;

      merged[emotion] =
        voiceScoreMap && faceScoreMap
          ? clamp(voice * 0.62 + face * 0.38, 0, 1)
          : clamp(voice + face, 0, 1);
    }

    return merged;
  }, [faceScoreMap, voiceScoreMap]);

  const sortedEmotionScores = blendedEmotionScores
    ? [...PLAYER_EMOTIONS]
        .map((emotion) => ({ emotion, score: blendedEmotionScores[emotion] ?? 0 }))
        .sort((a, b) => b.score - a.score)
    : [];

  const blendedEmotion = sortedEmotionScores[0]?.emotion ?? null;
  const blendedEmotionScore = sortedEmotionScores[0]?.score ?? null;
  const blendModeLabel = voiceScoreMap && faceScoreMap ? "voice + face" : voiceScoreMap ? "voice only" : faceScoreMap ? "face only" : "no signal";

  return (
    <main className="relative h-screen overflow-hidden px-2 py-2 md:px-4 md:py-3">
      <div className={`pointer-events-none fixed inset-0 ${flashLoss ? "loss-flash" : ""}`} />

      <div className="mx-auto flex h-full w-full max-w-[1700px] flex-col">
        <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_360px]">
          <aside className="tv-shell h-full min-h-0 overflow-hidden">
            <div className="tv-main min-h-0">
              <div className="tv-topline">
                <div className="flex items-center gap-2">
                  <span className="tv-status" />
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">
                    Character Feed
                  </p>
                </div>
                <p className="text-[11px] uppercase tracking-[0.15em] text-amber-100">{levelMeta.title}</p>
              </div>

              <div className="tv-screen-frame flex-1 min-h-0">
                <div className="tv-screen flex h-full min-h-0 flex-col gap-3 border-2 border-dashed border-cyan-400/35 p-3">
                  <div className="news-banner news-banner-strong">
                    <span className="news-tag">BBC News Alert</span>
                    <div className="news-strip">
                      <div className="news-track">
                        <span>{TV_NEWS_TICKER}</span>
                        <span>{TV_NEWS_TICKER}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-1 items-center justify-center text-center">
                    <div className="space-y-3">
                      <p className="text-xs uppercase tracking-[0.14em] text-cyan-200">Character Visual Feed</p>
                      <Image
                        src="/assets/game-small.svg"
                        alt="Character feed placeholder visual"
                        width={96}
                        height={96}
                        className="mx-auto rounded-lg border border-cyan-400/35 bg-slate-900/70 p-2"
                      />
                      <p className="text-sm text-slate-300">{levelMeta.visualHint}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2 rounded-xl border border-amber-400/25 bg-slate-900/75 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-amber-300">Objective</p>
                <p className="text-sm text-slate-200">{levelMeta.objective}</p>
                <p className="text-xs text-slate-400">Hint: {levelMeta.hint}</p>
              </div>

              <div className="space-y-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-emerald-300">Defuse Panel</p>
                {revealedCode ? (
                  <CodeEntry
                    codeKnown={true}
                    value={playerCodeInput}
                    disabled={busy || gameStatus !== "playing"}
                    onChange={setPlayerCodeInput}
                    onDefuse={handleDefuse}
                  />
                ) : (
                  <div className="rounded-lg border border-emerald-300/25 bg-slate-900/70 p-3 text-sm text-slate-300">
                    Waiting for the 4-digit code from the caller.
                  </div>
                )}
              </div>
            </div>

            <div className="tv-controls">
              <div className="tv-speaker">
                <div className="tv-speaker-line" />
                <div className="tv-speaker-line" />
                <div className="tv-speaker-line" />
                <div className="tv-speaker-line" />
                <div className="tv-speaker-line" />
              </div>
              <div className="tv-knob" />
              <div className="tv-knob" />
              <span className="tv-button" />
              <span className="tv-button" />
              <span className="tv-button" />
            </div>
          </aside>

          <section className="phone-frame h-full max-h-full w-full max-w-[340px] overflow-hidden lg:justify-self-end xl:max-w-[360px]">
            <div className="phone-notch" />
            <div className="phone-screen flex h-full min-h-0 flex-col gap-3 overflow-hidden">
              <div className="holo-outline flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="pulse-dot" />
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">
                    Call Connected
                  </p>
                </div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-slate-400">
                  Team Golden gAI
                </p>
              </div>

              <div className="holo-outline space-y-3 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Target</p>
                    <p className="text-lg font-semibold text-slate-100">{levelMeta.npcName}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill mood={npcMood} />
                    <div
                      className={`rounded-lg border px-3 py-1 font-mono text-xl font-bold ${
                        isDanger
                          ? "danger-glow border-red-400/60 text-red-300"
                          : "border-cyan-400/35 text-cyan-300"
                      }`}
                    >
                      {formatTime(timeRemaining)}
                    </div>
                  </div>
                </div>
                <Meters suspicion={suspicion} />
              </div>

              <div className="holo-outline space-y-2 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs uppercase tracking-[0.15em] text-cyan-300">Human Cam (Zoom)</p>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-400">
                    {webcamEnabled ? "Live" : "Offline"}
                  </p>
                </div>

                <div className="relative overflow-hidden rounded-xl border border-cyan-400/25 bg-slate-950/80">
                  <div className="aspect-[4/3] w-full">
                    {webcamEnabled ? (
                      <video
                        ref={webcamVideoRef}
                        muted
                        playsInline
                        autoPlay
                        className="h-full w-full object-cover"
                        style={{ transform: "scale(1.35) scaleX(-1)" }}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs uppercase tracking-[0.12em] text-slate-500">
                        Webcam feed unavailable
                      </div>
                    )}
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/90 to-transparent px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-cyan-200">
                    Face signal pipeline ready
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>{webcamError || "Facial model: baseline stub (neutral) pending live analyzer."}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (webcamEnabled) {
                        stopWebcam();
                        return;
                      }
                      setWebcamError("");
                      void startWebcam();
                    }}
                    className="rounded-md border border-cyan-400/35 px-2 py-1 text-cyan-300 transition hover:bg-cyan-400/10"
                  >
                    {webcamEnabled ? "Disable" : "Enable"}
                  </button>
                </div>
              </div>

              <ConversationLog history={history} loading={busy} maxItems={2} />

              <div className="holo-outline space-y-2 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs uppercase tracking-[0.15em] text-amber-300">Emotion Signal</p>
                  <p className="text-[11px] text-slate-400">
                    {isRecording
                      ? isLiveSyncing
                        ? "Analyzing..."
                        : "Recording..."
                      : isTranscribing
                        ? "Finalizing..."
                        : "Idle"}
                  </p>
                </div>
                {lastEmotion || faceEmotion || blendedEmotion ? (
                  <p className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-xs uppercase tracking-[0.12em] text-amber-200">
                    Voice: {lastEmotion ?? "n/a"}
                    {typeof lastEmotionScore === "number" ? ` (${Math.round(lastEmotionScore * 100)}%)` : ""}
                    {"  •  "}
                    Face: {faceEmotion ?? "n/a"}
                    {typeof faceEmotionScore === "number" ? ` (${Math.round(faceEmotionScore * 100)}%)` : ""}
                    {"  •  "}
                    Blend: {blendedEmotion ?? "n/a"}
                    {typeof blendedEmotionScore === "number"
                      ? ` (${Math.round(blendedEmotionScore * 100)}%)`
                      : ""}
                  </p>
                ) : (
                  <p className="rounded-lg border border-slate-700 bg-slate-900/70 px-2 py-1 text-xs text-slate-400">
                    No emotion sample yet.
                  </p>
                )}
                <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Blend mode: {blendModeLabel}</p>
                {sortedEmotionScores.length > 0 ? (
                  <div className="grid grid-cols-2 gap-1 text-[11px]">
                    {sortedEmotionScores.map((entry) => (
                      <p
                        key={entry.emotion}
                        className="flex items-center justify-between rounded border border-slate-700/80 bg-slate-900/70 px-2 py-1 uppercase tracking-[0.06em] text-slate-300"
                      >
                        <span>{entry.emotion}</span>
                        <span>{Math.round(entry.score * 100)}%</span>
                      </p>
                    ))}
                  </div>
                ) : null}
                {lastTranscript ? (
                  <p className="text-[11px] text-slate-500">
                    Last sent: <span className="text-slate-300">{lastTranscript}</span>
                  </p>
                ) : null}
              </div>

              {micError ? (
                <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                  {micError}
                </p>
              ) : null}

              {gameStatus === "playing" ? (
                <div className="space-y-3">
                  {recordingSupported ? (
                    <PushToTalk
                      disabled={busy}
                      isRecording={isRecording}
                      onPressStart={() => {
                        void handlePressStart();
                      }}
                      onPressEnd={handlePressEnd}
                    />
                  ) : (
                    <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                      Browser microphone recording is unavailable.
                    </p>
                  )}
                </div>
              ) : null}

              {gameStatus === "idle" ? (
                <div className="space-y-3 rounded-xl border border-cyan-400/35 bg-cyan-500/10 p-4">
                  <p className="text-xl font-black uppercase tracking-[0.1em] text-cyan-200">
                    2-Level Campaign
                  </p>
                  <p className="text-sm text-slate-200">
                    Level 1: pressure a fearful villain. Level 2: charm a cute cat with affection.
                  </p>
                  <button
                    type="button"
                    onClick={() => startLevel(1)}
                    className="w-full rounded-xl bg-emerald-500 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] text-slate-950 transition hover:bg-emerald-400"
                  >
                    Start Level 1
                  </button>
                </div>
              ) : null}

              {gameStatus === "won" ? (
                <div className="space-y-3 rounded-xl border border-emerald-400/45 bg-emerald-500/10 p-4">
                  <p className="text-2xl font-black uppercase tracking-[0.12em] text-emerald-300">
                    {currentLevel === 1 ? "Level 1 Cleared" : "All Levels Cleared"}
                  </p>
                  <p className="text-sm text-slate-200">
                    Time remaining: <span className="font-bold text-emerald-300">{timeRemaining}s</span>
                  </p>
                  {currentLevel === 1 ? (
                    <button
                      type="button"
                      onClick={() => startLevel(2)}
                      className="w-full rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
                    >
                      Start Level 2
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startLevel(1)}
                      className="w-full rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
                    >
                      Restart Campaign
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleResetToIdle}
                    className="w-full rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-white"
                  >
                    Back to Home
                  </button>
                </div>
              ) : null}

              {gameStatus === "lost" ? (
                <div className="space-y-3 rounded-xl border border-red-400/45 bg-red-500/10 p-4">
                  <p className="text-2xl font-black uppercase tracking-[0.12em] text-red-300">
                    {loseReason ?? "Call Ended"}
                  </p>
                  <p className="text-sm text-slate-200">
                    {loseReason === "TIME OUT"
                      ? "Timer reached zero before defuse confirmation."
                      : "Target cut the line after suspicion spiked."}
                  </p>
                  <button
                    type="button"
                    onClick={() => startLevel(currentLevel)}
                    className="w-full rounded-lg bg-red-300 px-4 py-2 text-sm font-semibold text-red-950 transition hover:bg-red-200"
                  >
                    Retry Current Level
                  </button>
                  <button
                    type="button"
                    onClick={handleResetToIdle}
                    className="w-full rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-white"
                  >
                    Back to Home
                  </button>
                </div>
              ) : null}

              <div className="phone-home" />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
