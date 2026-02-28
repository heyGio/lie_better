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
const INTRO_LINE_DELAY_MS = 900;
const SPACE_READY_DELAY_MS = 850;

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
  const [statusLine, setStatusLine] = useState("Press Enter to initiate the call.");

  const busy = isTranscribing || loading;

  const historyRef = useRef<HistoryItem[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const recordingSessionRef = useRef(0);
  const spacePttActiveRef = useRef(false);

  const introLineTimeoutRef = useRef<number | null>(null);
  const spaceReadyTimeoutRef = useRef<number | null>(null);

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
        // Ignore stop failures.
      }
    } else {
      setIsRecording(false);
    }
  }, []);

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
      if (!transcript.trim()) return;

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
        round
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
          npcMood: data.npcMood
        });

        if (data.shouldHangUp) {
          setTimerRunning(false);
          setCanTalk(false);
          setStatusLine("Call ended by target.");
          console.warn("📴  [Call] Target ended the call.");
          return;
        }

        if (data.revealCode && data.code) {
          setStatusLine(`Code revealed: ${data.code}`);
        } else {
          setStatusLine("Press Space to Talk");
        }
      } catch (error) {
        console.error("🚨  [Turn] Evaluation error", error);
        setStatusLine("Connection glitch. Press Space to retry.");
      } finally {
        setLoading(false);
      }
    },
    [replaceHistory, suspicion, timeRemaining]
  );

  const handlePressStart = useCallback(async () => {
    if (!hasStarted || !canTalk || busy || isRecording || timeRemaining <= 0) return;
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

          console.info("🧠  [Emotion] Voice analysis", {
            transcript: result.transcript,
            emotion: result.emotion,
            emotionScore: result.emotionScore,
            emotionScores: result.emotionScores
          });

          await submitTurn(
            result.transcript,
            result.emotion,
            result.emotionScore,
            result.emotionScores
          );
        } catch (error) {
          console.error("🚨  [Audio] Transcription error", error);
          setMicError("Could not transcribe audio. Try again.");
          setStatusLine("Mic/transcription issue. Press Space to retry.");
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
  }, [busy, canTalk, hasStarted, isRecording, recordingSupported, submitTurn, timeRemaining, transcribeBlob]);

  const handlePressEnd = useCallback(() => {
    if (!isRecording) return;
    stopRecording(false);
    setStatusLine("Processing your message...");
  }, [isRecording, stopRecording]);

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();

      setHasStarted((prev) => {
        if (prev) return prev;

        console.info("🚀  [Intro] Enter pressed, starting cinematic sequence");
        setShowCharacter(true);
        setStatusLine("Connecting call...");

        introLineTimeoutRef.current = window.setTimeout(() => {
          setShowOpeningLine(true);
          replaceHistory([{ role: "npc", content: OPENING_LINE }]);
          setTimerRunning(true);
          setTimeRemaining(START_TIME);
          setStatusLine("Incoming line...");

          spaceReadyTimeoutRef.current = window.setTimeout(() => {
            setCanTalk(true);
            setStatusLine("Press Space to Talk");
            console.info("⌨️  [Intro] Space-to-talk is now enabled");
          }, SPACE_READY_DELAY_MS);
        }, INTRO_LINE_DELAY_MS);

        return true;
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [replaceHistory]);

  useEffect(() => {
    if (!hasStarted || !canTalk) return;

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
  }, [canTalk, handlePressEnd, handlePressStart, hasStarted]);

  useEffect(() => {
    if (!timerRunning) return;

    const interval = window.setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval);
          setTimerRunning(false);
          setCanTalk(false);
          setStatusLine("TIME OUT");
          console.warn("⏳  [Timer] Time out");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [timerRunning]);

  useEffect(() => {
    return () => {
      if (introLineTimeoutRef.current !== null) {
        window.clearTimeout(introLineTimeoutRef.current);
        introLineTimeoutRef.current = null;
      }
      if (spaceReadyTimeoutRef.current !== null) {
        window.clearTimeout(spaceReadyTimeoutRef.current);
        spaceReadyTimeoutRef.current = null;
      }
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

      <p
        className={`pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 rounded-lg border border-white/20 bg-black/42 px-4 py-2 text-xs uppercase tracking-[0.24em] text-slate-100/95 shadow-[0_0_25px_rgba(2,6,23,0.7)] transition-all duration-700 md:text-sm ${
          hasStarted ? "translate-y-2 opacity-0" : "opacity-100"
        }`}
      >
        Press Enter To Continue...
      </p>

      <div
        className={`pointer-events-none absolute left-4 top-4 rounded-lg border border-cyan-300/35 bg-slate-950/55 px-4 py-2 font-mono text-xl font-bold text-cyan-200 transition-all duration-700 md:left-8 md:top-8 md:text-3xl ${
          hasStarted ? "opacity-100" : "opacity-0"
        }`}
      >
        {formatTime(timeRemaining)}
      </div>

      <div
        className={`pointer-events-none absolute left-4 top-20 rounded-md border border-cyan-300/30 bg-slate-950/45 px-3 py-1 text-xs uppercase tracking-[0.12em] text-cyan-100 transition-all duration-700 md:left-8 ${
          hasStarted ? "opacity-100" : "opacity-0"
        }`}
      >
        Suspicion {suspicion} • Mood {npcMood}
      </div>

      <div className="relative flex h-full w-full items-end justify-end pr-4 md:pr-12 lg:pr-20">
        <div
          className={`relative h-[82vh] w-[48vw] min-w-[260px] max-w-[700px] transition-all duration-[1300ms] ease-out ${
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
            className={`pointer-events-none absolute left-[-42%] top-[12%] w-[min(380px,74vw)] rounded-2xl border border-cyan-300/40 bg-slate-950/78 px-4 py-3 text-left shadow-[0_0_30px_rgba(34,211,238,0.22)] backdrop-blur-sm transition-all duration-700 md:left-[-36%] ${
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
            className={`pointer-events-none absolute left-[-36%] top-[40%] rounded-lg border border-emerald-300/35 bg-emerald-500/10 px-3 py-2 text-xs uppercase tracking-[0.12em] text-emerald-200 transition-all duration-700 ${
              canTalk ? "opacity-100" : "opacity-0"
            }`}
          >
            {isRecording
              ? "Recording... release Space"
              : busy
                ? "Analyzing..."
                : "Press Space To Talk"}
          </div>

          {lastTranscript ? (
            <div className="pointer-events-none absolute left-[-44%] top-[54%] w-[min(360px,72vw)] rounded-xl border border-fuchsia-300/35 bg-slate-950/70 px-3 py-2 text-xs text-slate-100 backdrop-blur-sm md:text-sm">
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
        <p className="pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 rounded-lg border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-xs text-amber-200 md:text-sm">
          {micError}
        </p>
      ) : null}

      <p className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-slate-400/30 bg-black/40 px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-slate-200/95">
        {statusLine}
      </p>
    </main>
  );
}
