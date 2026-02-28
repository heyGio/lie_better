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

export default function Home() {
  const [gameStatus, setGameStatus] = useState<GameStatus>("idle");
  const [timeRemaining, setTimeRemaining] = useState<number>(START_TIME);
  const [suspicion, setSuspicion] = useState<number>(START_SUSPICION);
  const [npcMood, setNpcMood] = useState<NpcMood>("suspicious");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [playerCodeInput, setPlayerCodeInput] = useState<string>("");
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [draftTranscript, setDraftTranscript] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [speechSupported, setSpeechSupported] = useState<boolean>(false);
  const [loseReason, setLoseReason] = useState<LoseReason>(null);
  const [flashLoss, setFlashLoss] = useState<boolean>(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const speechTranscriptRef = useRef<string>("");

  const isDanger = gameStatus === "playing" && timeRemaining < 30;
  const stopRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setIsRecording(false);
      return;
    }

    try {
      recognition.stop();
    } catch {
      // Ignored: stop can throw if recognition isn't started.
    } finally {
      setIsRecording(false);
    }
  }, []);

  const triggerLoss = useCallback(
    (reason: Exclude<LoseReason, null>) => {
      stopRecognition();
      setLoading(false);
      setGameStatus("lost");
      setLoseReason(reason);
      setFlashLoss(true);
      setTimeout(() => setFlashLoss(false), 900);
    },
    [stopRecognition]
  );

  const submitTurn = useCallback(
    async (rawTranscript: string) => {
      const transcript = rawTranscript.trim();
      if (!transcript || gameStatus !== "playing" || loading) return;

      setLoading(true);
      setLastTranscript(transcript);
      setDraftTranscript("");

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

  useEffect(() => {
    if (typeof window === "undefined") return;

    const RecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      setSpeechSupported(false);
      return;
    }

    setSpeechSupported(true);

    const recognition = new RecognitionCtor();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let aggregate = "";
      for (let i = 0; i < event.results.length; i += 1) {
        aggregate += event.results[i][0]?.transcript ?? "";
      }
      const text = aggregate.trim();
      speechTranscriptRef.current = text;
      setDraftTranscript(text);
    };

    recognition.onerror = () => {
      setIsRecording(false);
    };

    recognition.onend = () => {
      setIsRecording(false);
      const spoken = speechTranscriptRef.current.trim();
      speechTranscriptRef.current = "";
      if (spoken) void submitTurn(spoken);
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // Safe cleanup.
      }
      recognitionRef.current = null;
    };
  }, [submitTurn]);

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
    setLoseReason(null);
    setFlashLoss(false);
  };

  const handleReset = () => {
    stopRecognition();
    setGameStatus("idle");
    setTimeRemaining(START_TIME);
    setSuspicion(START_SUSPICION);
    setNpcMood("suspicious");
    setHistory([]);
    setRevealedCode(null);
    setPlayerCodeInput("");
    setLastTranscript("");
    setDraftTranscript("");
    setLoseReason(null);
    setLoading(false);
    setFlashLoss(false);
  };

  const handlePressStart = () => {
    if (!speechSupported || gameStatus !== "playing" || loading || isRecording) return;
    const recognition = recognitionRef.current;
    if (!recognition) return;

    speechTranscriptRef.current = "";
    setDraftTranscript("");

    try {
      recognition.start();
      setIsRecording(true);
    } catch {
      setIsRecording(false);
    }
  };

  const handlePressEnd = () => {
    if (!isRecording) return;
    stopRecognition();
  };

  const handleManualSend = () => {
    void submitTurn(draftTranscript);
  };

  const handleDefuse = () => {
    if (gameStatus !== "playing" || !revealedCode) return;

    if (playerCodeInput === revealedCode) {
      stopRecognition();
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

          <ConversationLog history={history} loading={loading} />
          <Meters suspicion={suspicion} />

          <div className="text-xs text-slate-400">
            Last transcript:{" "}
            <span className="font-medium text-slate-200">
              {lastTranscript || "No line submitted yet."}
            </span>
          </div>

          {gameStatus === "playing" ? (
            <div className="space-y-3">
              {speechSupported ? (
                <PushToTalk
                  disabled={loading}
                  isRecording={isRecording}
                  onPressStart={handlePressStart}
                  onPressEnd={handlePressEnd}
                />
              ) : (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                  Web Speech API is unavailable in this browser. Use manual text input below.
                </p>
              )}

              <TranscriptInput
                value={draftTranscript}
                disabled={loading || gameStatus !== "playing"}
                helperText={
                  speechSupported
                    ? "Speech text appears here and auto-sends on release. You can also edit and send manually."
                    : "Type your line manually, then send."
                }
                onChange={setDraftTranscript}
                onSend={handleManualSend}
              />

              <CodeEntry
                codeKnown={Boolean(revealedCode)}
                value={playerCodeInput}
                disabled={loading}
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
