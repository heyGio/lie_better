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
  error?: string;
}

interface TranscriptionResult {
  transcript: string;
  emotion: PlayerEmotion | null;
  emotionScore: number | null;
  emotionScores: EmotionScores | null;
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
}

const START_TIME = 120;
const START_SUSPICION = 50;
const OPENING_LINE = "Who is this? You have 2 minutes. Talk.";
const DARKEN_DELAY_MS = 180;
const OPENING_LINE_DELAY_MS = 980;
const TALK_READY_DELAY_MS = 1720;

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

export default function Home() {
  const [hasStarted, setHasStarted] = useState(false);
  const [showCharacter, setShowCharacter] = useState(false);
  const [showOpeningLine, setShowOpeningLine] = useState(false);
  const [canTalk, setCanTalk] = useState(false);

  const [timeRemaining, setTimeRemaining] = useState(START_TIME);
  const [timerRunning, setTimerRunning] = useState(false);

  const [suspicion, setSuspicion] = useState(START_SUSPICION);
  const [npcMood, setNpcMood] = useState<NpcMood>("suspicious");

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

  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [playerCodeInput, setPlayerCodeInput] = useState("");
  const [won, setWon] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [explodeReason, setExplodeReason] = useState("");

  const [statusLine, setStatusLine] = useState("Connecting secure channel...");

  const busy = isTranscribing || loading;

  const historyRef = useRef<HistoryItem[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const recordingSessionRef = useRef(0);
  const spacePttActiveRef = useRef(false);

  const darkenTimeoutRef = useRef<number | null>(null);
  const openingLineTimeoutRef = useRef<number | null>(null);
  const talkReadyTimeoutRef = useRef<number | null>(null);

  const replaceHistory = useCallback((next: HistoryItem[]) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

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
      setExploded(true);
      setExplodeReason(reason);
      setTimerRunning(false);
      setCanTalk(false);
      setStatusLine(`BOOM · ${reason}`);
      console.error("💥  [Bomb] Device exploded", { reason, timeRemaining, suspicion, revealedCode });
    },
    [exploded, revealedCode, stopRecording, suspicion, timeRemaining, won]
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
      emotionScores: parseEmotionScores(payload.emotionScores)
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

        console.info("🎭  [Turn] NPC evaluation", {
          npcReply: data.npcReply,
          scores: data.scores,
          suspicionDelta: data.suspicionDelta,
          newSuspicion: data.newSuspicion,
          shouldHangUp: data.shouldHangUp,
          revealCode: data.revealCode,
          code: data.code,
          npcMood: data.npcMood,
          conversation: withNpc
        });

        if (data.revealCode && data.code) {
          setRevealedCode(data.code);
          setStatusLine("Code leaked. Enter it on the bomb panel.");
        } else {
          setStatusLine(data.shouldHangUp ? "Call ended. Try the bomb panel." : "Press Space to Talk");
        }

        if (data.shouldHangUp) {
          setCanTalk(false);
          console.warn("📴  [Call] Target ended the call");
        }
      } catch (error) {
        console.error("🚨  [Turn] Evaluation error", error);
        setStatusLine("Connection glitch. Hold Space and retry.");
      } finally {
        setLoading(false);
      }
    },
    [exploded, replaceHistory, suspicion, timeRemaining, timerRunning, won]
  );

  const handlePressStart = useCallback(async () => {
    if (!hasStarted || !canTalk || busy || isRecording || timeRemaining <= 0 || exploded || won) return;

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

          const fallback = inferEmotionFromTranscript(result.transcript);
          const finalEmotion = result.emotion ?? fallback.emotion;
          const finalEmotionScore = result.emotionScore ?? fallback.score;
          const finalEmotionScores = result.emotionScores ?? fallback.scores;

          console.info("🧠  [Emotion] Voice analysis", {
            transcript: result.transcript,
            emotion: finalEmotion,
            emotionScore: finalEmotionScore,
            emotionScores: finalEmotionScores,
            source: result.emotion ? "huggingface" : "fallback-text"
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
  }, [busy, canTalk, exploded, hasStarted, isRecording, recordingSupported, submitTurn, timeRemaining, transcribeBlob, won]);

  const handlePressEnd = useCallback(() => {
    if (!isRecording) return;
    stopRecording(false);
    setStatusLine("Processing your message...");
  }, [isRecording, stopRecording]);

  const handleCodeSubmit = useCallback(() => {
    if (won || exploded) return;

    const attemptedCode = playerCodeInput.trim();
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

    triggerExplosion("Wrong code entered");
  }, [exploded, playerCodeInput, revealedCode, timeRemaining, triggerExplosion, won]);

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
    console.info("🚀  [Intro] Auto call init sequence started");

    darkenTimeoutRef.current = window.setTimeout(() => {
      setHasStarted(true);
      setShowCharacter(true);
      setStatusLine("Connecting secure call...");
    }, DARKEN_DELAY_MS);

    openingLineTimeoutRef.current = window.setTimeout(() => {
      setShowOpeningLine(true);
      replaceHistory([{ role: "npc", content: OPENING_LINE }]);
      setTimerRunning(true);
      setTimeRemaining(START_TIME);
      setStatusLine("Unknown Caller is speaking...");
      console.info("📞  [Intro] Opening line displayed, timer started");
    }, OPENING_LINE_DELAY_MS);

    talkReadyTimeoutRef.current = window.setTimeout(() => {
      setCanTalk(true);
      setStatusLine("Press Space to Talk");
      console.info("⌨️  [Intro] Space-to-talk enabled");
    }, TALK_READY_DELAY_MS);

    return () => {
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
    };
  }, [replaceHistory]);

  useEffect(() => {
    if (!hasStarted || !canTalk || exploded || won) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (shouldIgnoreSpaceHotkey(event.target)) return;

      event.preventDefault();
      if (event.repeat || spacePttActiveRef.current) return;

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

    const onBlur = () => {
      if (!spacePttActiveRef.current) return;
      spacePttActiveRef.current = false;
      handlePressEnd();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      spacePttActiveRef.current = false;
    };
  }, [canTalk, exploded, handlePressEnd, handlePressStart, hasStarted, won]);

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
    return () => {
      stopRecording(true);
      releaseMicrophone();
    };
  }, [releaseMicrophone, stopRecording]);

  const latestNpcLine = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === "npc") return history[i].content;
    }
    return OPENING_LINE;
  }, [history]);

  const topEmotionDetail = useMemo(() => {
    if (!lastEmotionScores) return null;

    const entries = Object.entries(lastEmotionScores) as Array<[PlayerEmotion, number]>;
    entries.sort((a, b) => b[1] - a[1]);
    const [emotion, score] = entries[0] ?? [null, 0];
    if (!emotion || !Number.isFinite(score) || score <= 0) return null;
    return { emotion, score };
  }, [lastEmotionScores]);

  return (
    <main className="relative h-screen w-screen overflow-hidden select-none">
      <div
        className={`pointer-events-none absolute inset-0 bg-black transition-opacity duration-[1400ms] ease-out ${
          hasStarted ? "opacity-60" : "opacity-0"
        }`}
      />

      {exploded ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-red-950/78">
          <div className="rounded-2xl border border-red-300/65 bg-red-500/15 px-8 py-6 text-center shadow-[0_0_45px_rgba(248,113,113,0.5)]">
            <p className="text-4xl font-black uppercase tracking-[0.2em] text-red-200">BOOM</p>
            <p className="mt-2 text-sm uppercase tracking-[0.12em] text-red-100">{explodeReason || "Device exploded"}</p>
          </div>
        </div>
      ) : null}

      {won ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-emerald-950/70">
          <div className="rounded-2xl border border-emerald-300/65 bg-emerald-500/15 px-8 py-6 text-center shadow-[0_0_45px_rgba(74,222,128,0.45)]">
            <p className="text-3xl font-black uppercase tracking-[0.18em] text-emerald-200">DEVICE DISARMED</p>
            <p className="mt-2 text-sm uppercase tracking-[0.12em] text-emerald-100">Time left: {formatTime(timeRemaining)}</p>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-cyan-300/35 bg-slate-950/55 px-4 py-2 font-mono text-xl font-bold text-cyan-200 md:left-8 md:top-8 md:text-3xl">
        Suspicion {suspicion} • {npcMood}
      </div>

      <div className="absolute left-3 top-1/2 z-20 w-[44vw] max-w-[560px] min-w-[280px] -translate-y-1/2 px-2 md:left-6 md:px-0">
        <div className="rounded-2xl border border-red-300/35 bg-slate-950/65 p-4 shadow-[0_0_35px_rgba(248,113,113,0.2)] backdrop-blur-sm md:p-5">
          <p className="mb-3 text-xs uppercase tracking-[0.14em] text-red-200/90">Defuse Device</p>

          <div className="relative mx-auto mb-4 h-48 w-48 rounded-full border-4 border-red-300/70 bg-gradient-to-b from-red-800/65 to-slate-900/95 shadow-[0_0_45px_rgba(248,113,113,0.4)] md:h-56 md:w-56">
            <div className="absolute right-4 top-3 h-5 w-16 rotate-12 rounded-sm bg-amber-400/85" />
            <div className="absolute right-1 top-0 h-3 w-20 rotate-[22deg] rounded-sm bg-red-500/75" />
            <div className="absolute left-1/2 top-1/2 w-[78%] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-red-200/60 bg-slate-950/82 px-3 py-2 text-center">
              <p className="text-[10px] uppercase tracking-[0.16em] text-red-100/85">Timer</p>
              <p className="font-mono text-3xl font-black tracking-[0.08em] text-red-200 md:text-4xl">
                {formatTime(timeRemaining)}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              value={playerCodeInput}
              onChange={(event) => setPlayerCodeInput(event.target.value.replace(/\D/g, "").slice(0, 4))}
              inputMode="numeric"
              maxLength={4}
              placeholder="0000"
              disabled={exploded || won}
              className="w-full rounded-lg border border-red-300/35 bg-slate-900/78 px-3 py-2 text-center font-mono text-2xl tracking-[0.28em] text-red-100 outline-none ring-red-300 transition focus:ring-2 disabled:opacity-55"
            />
            <button
              type="button"
              disabled={exploded || won || playerCodeInput.length !== 4}
              onClick={handleCodeSubmit}
              className="rounded-lg border border-red-200/45 bg-red-500/80 px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-red-950 transition hover:bg-red-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
            >
              Test
            </button>
          </div>

          <p className="mt-2 text-[11px] uppercase tracking-[0.1em] text-red-100/80">
            {revealedCode ? "Code intercepted. Enter now." : "Wrong code explodes the device."}
          </p>
        </div>
      </div>

      <div className="relative flex h-full w-full items-end justify-end pr-3 md:pr-10 lg:pr-16">
        <div
          className={`relative h-[84vh] w-[48vw] min-w-[260px] max-w-[720px] transition-all duration-[1200ms] ease-out ${
            showCharacter ? "translate-x-0 scale-100 opacity-100" : "translate-x-10 scale-95 opacity-0"
          }`}
        >
          <Image
            src="/assets/cat2.png"
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
            className={`pointer-events-none absolute left-[-40%] top-[40%] rounded-lg border border-emerald-300/35 bg-emerald-500/10 px-3 py-2 text-xs uppercase tracking-[0.12em] text-emerald-200 transition-all duration-700 ${
              canTalk ? "opacity-100" : "opacity-0"
            }`}
          >
            {isRecording
              ? "Recording... release Space"
              : busy
                ? "Analyzing..."
                : "Press Space to Talk"}
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

      <p className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-slate-400/35 bg-black/45 px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-slate-200/95 md:text-xs">
        {statusLine}
      </p>
    </main>
  );
}
