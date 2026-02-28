"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CodeEntry } from "@/app/components/CodeEntry";
import { ConversationLog } from "@/app/components/ConversationLog";
import { GameHeader } from "@/app/components/GameHeader";
import { Meters } from "@/app/components/Meters";
import { PushToTalk } from "@/app/components/PushToTalk";
import { StatusPill } from "@/app/components/StatusPill";
import { TimerDisplay } from "@/app/components/TimerDisplay";
import { TranscriptInput } from "@/app/components/TranscriptInput";
import type { HistoryItem, NpcMood } from "@/app/components/types";

type GameStatus = "idle" | "playing" | "won" | "lost";
type LoseReason = "CALL ENDED" | "TIME OUT" | null;

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
  error?: string;
}

const START_TIME = 120;
const START_SUSPICION = 50;
const INITIAL_NPC_LINE = "Who is this? You have 2 minutes. Talk.";

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
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return "";
}

export default function Home() {
  const [gameStatus, setGameStatus] = useState<GameStatus>("idle");
  const [timeRemaining, setTimeRemaining] = useState<number>(START_TIME);
  const [suspicion, setSuspicion] = useState<number>(START_SUSPICION);
  const [npcMood, setNpcMood] = useState<NpcMood>("suspicious");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [playerCodeInput, setPlayerCodeInput] = useState<string>("");
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [draftTranscript, setDraftTranscript] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [recordingSupported, setRecordingSupported] = useState<boolean>(false);
  const [micError, setMicError] = useState<string>("");
  const [loseReason, setLoseReason] = useState<LoseReason>(null);
  const [flashLoss, setFlashLoss] = useState<boolean>(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef<boolean>(false);

  const isDanger = gameStatus === "playing" && timeRemaining < 30;

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
        // Ignore stop errors.
      }
    } else {
      setIsRecording(false);
    }
  }, []);

  const triggerLoss = useCallback(
    (reason: Exclude<LoseReason, null>) => {
      stopRecording(true);
      setLoading(false);
      setIsTranscribing(false);
      setGameStatus("lost");
      setLoseReason(reason);
      setFlashLoss(true);
      setTimeout(() => setFlashLoss(false), 900);
    },
    [stopRecording]
  );

  const submitTurn = useCallback(
    async (rawTranscript: string) => {
      const transcript = rawTranscript.trim();
      if (!transcript || gameStatus !== "playing" || loading) return;

      setLoading(true);
      setLastTranscript(transcript);
      setDraftTranscript("");
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
            round
          })
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? "Failed to evaluate transcript.");
        }

        const data = (await response.json()) as EvaluateResponse;

        setHistory((prev) => [...prev, { role: "npc", content: data.npcReply }]);
        setSuspicion(clamp(data.newSuspicion, 0, 100));
        setNpcMood(data.npcMood);

        if (data.revealCode && data.code) {
          setRevealedCode(data.code);
        }

        if (data.shouldHangUp) {
          triggerLoss("CALL ENDED");
          return;
        }
      } catch (error) {
        console.error("🚨  [Game] Evaluation failed", error);
        const fallbackSuspicion = clamp(suspicion + 4, 0, 100);
        setSuspicion(fallbackSuspicion);
        setNpcMood(moodFromSuspicion(fallbackSuspicion));
        setHistory((prev) => [
          ...prev,
          {
            role: "npc",
            content: "Line is breaking. You're sounding uncertain. Speak clearly."
          }
        ]);
        if (fallbackSuspicion >= 85) {
          triggerLoss("CALL ENDED");
          return;
        }
      } finally {
        setLoading(false);
      }
    },
    [gameStatus, history, loading, suspicion, timeRemaining, triggerLoss]
  );

  const transcribeAndSubmit = useCallback(
    async (audioBlob: Blob) => {
      if (gameStatus !== "playing") return;

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

      setIsTranscribing(true);
      setMicError("");

      try {
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

        setDraftTranscript(transcript);
        await submitTurn(transcript);
      } catch (error) {
        console.error("🚨  [Game] Audio transcription failed", error);
        setMicError("Could not transcribe audio. Type your line manually.");
      } finally {
        setIsTranscribing(false);
      }
    },
    [gameStatus, submitTurn]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const hasMediaRecorder =
      typeof window.MediaRecorder !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function";

    setRecordingSupported(hasMediaRecorder);
  }, []);

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
      releaseMicrophone();
    };
  }, [releaseMicrophone, stopRecording]);

  const handleStartCall = () => {
    setGameStatus("playing");
    setTimeRemaining(START_TIME);
    setSuspicion(START_SUSPICION);
    setNpcMood("suspicious");
    setHistory([{ role: "npc", content: INITIAL_NPC_LINE }]);
    setRevealedCode(null);
    setPlayerCodeInput("");
    setLastTranscript("");
    setDraftTranscript("");
    setMicError("");
    setLoseReason(null);
    setFlashLoss(false);
  };

  const handleReset = () => {
    stopRecording(true);
    releaseMicrophone();
    setGameStatus("idle");
    setTimeRemaining(START_TIME);
    setSuspicion(START_SUSPICION);
    setNpcMood("suspicious");
    setHistory([]);
    setRevealedCode(null);
    setPlayerCodeInput("");
    setLastTranscript("");
    setDraftTranscript("");
    setMicError("");
    setLoseReason(null);
    setLoading(false);
    setIsTranscribing(false);
    setFlashLoss(false);
  };

  const handlePressStart = async () => {
    if (!recordingSupported || gameStatus !== "playing" || loading || isTranscribing || isRecording) {
      return;
    }

    setDraftTranscript("");
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
        setMicError("Microphone recorder failed. Try typing manually.");
        setIsRecording(false);
      };

      recorder.onstop = async () => {
        setIsRecording(false);

        if (discardRecordingRef.current) {
          discardRecordingRef.current = false;
          audioChunksRef.current = [];
          return;
        }

        const audioBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm"
        });
        audioChunksRef.current = [];

        if (audioBlob.size < 1024) {
          setMicError("Audio too short. Hold the button while speaking.");
          return;
        }

        await transcribeAndSubmit(audioBlob);
      };

      recorder.start(200);
      setIsRecording(true);
      console.info("🎙️  [Audio] Recording started");
    } catch (error) {
      console.error("🚨  [Audio] Unable to start recording", error);
      setMicError("Microphone access denied or unavailable. Use manual text input.");
      setIsRecording(false);
    }
  };

  const handlePressEnd = () => {
    if (!isRecording) return;
    stopRecording(false);
  };

  const handleManualSend = () => {
    void submitTurn(draftTranscript);
  };

  const handleDefuse = () => {
    if (gameStatus !== "playing" || !revealedCode) return;

    if (playerCodeInput === revealedCode) {
      stopRecording(true);
      setGameStatus("won");
      setLoseReason(null);
      setHistory((prev) => [
        ...prev,
        { role: "npc", content: "Code accepted. Device disarmed. You got lucky." }
      ]);
      return;
    }

    const raisedSuspicion = clamp(suspicion + 8, 0, 100);
    setSuspicion(raisedSuspicion);
    setNpcMood(moodFromSuspicion(raisedSuspicion));
    setPlayerCodeInput("");
    setHistory((prev) => [
      ...prev,
      { role: "npc", content: "Wrong code. You're guessing. Why should I trust you?" }
    ]);

    if (raisedSuspicion >= 85) {
      triggerLoss("CALL ENDED");
    }
  };

  const busy = loading || isTranscribing;

  return (
    <main className="relative min-h-screen px-4 py-6 md:px-8 md:py-10">
      <div className={`pointer-events-none fixed inset-0 ${flashLoss ? "loss-flash" : ""}`} />

      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <GameHeader />
        <TimerDisplay timeRemaining={timeRemaining} isDanger={isDanger} />

        <section className="panel space-y-4 p-4 md:p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">
                Call Connected
              </p>
              <p className="text-lg font-semibold text-slate-100">Unknown Caller</p>
            </div>
            <StatusPill mood={npcMood} />
          </div>

          <ConversationLog history={history} loading={busy} />
          <Meters suspicion={suspicion} />

          <div className="text-xs text-slate-400">
            Last transcript:{" "}
            <span className="font-medium text-slate-200">
              {lastTranscript || "No line submitted yet."}
            </span>
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
                  Browser microphone recording is unavailable. Use manual text input below.
                </p>
              )}

              <TranscriptInput
                value={draftTranscript}
                disabled={busy || gameStatus !== "playing"}
                helperText={
                  recordingSupported
                    ? isTranscribing
                      ? "Transcribing with Mistral..."
                      : "Hold Push to Talk, release to transcribe with Mistral, then auto-send."
                    : "Type your line manually, then send."
                }
                onChange={setDraftTranscript}
                onSend={handleManualSend}
              />

              <CodeEntry
                codeKnown={Boolean(revealedCode)}
                value={playerCodeInput}
                disabled={busy}
                onChange={setPlayerCodeInput}
                onDefuse={handleDefuse}
              />
            </div>
          ) : null}

          {gameStatus === "idle" ? (
            <button
              type="button"
              onClick={handleStartCall}
              className="w-full rounded-xl bg-emerald-500 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] text-slate-950 transition hover:bg-emerald-400"
            >
              Start Call
            </button>
          ) : null}

          {gameStatus === "won" ? (
            <div className="space-y-3 rounded-xl border border-emerald-400/45 bg-emerald-500/10 p-4">
              <p className="text-2xl font-black uppercase tracking-[0.12em] text-emerald-300">
                Device Disarmed
              </p>
              <p className="text-sm text-slate-200">
                Time remaining: <span className="font-bold text-emerald-300">{timeRemaining}s</span>
              </p>
              <button
                type="button"
                onClick={handleReset}
                className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-white"
              >
                Reset
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
                  ? "You ran out of time before securing the defuse code."
                  : "The NPC hung up after your suspicion crossed the limit."}
              </p>
              <button
                type="button"
                onClick={handleReset}
                className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-white"
              >
                Reset
              </button>
            </div>
          ) : null}
        </section>

        <p className="text-center text-xs text-slate-500">
          Fictional scenario only. No real-world harmful guidance.
        </p>
      </div>
    </main>
  );
}
