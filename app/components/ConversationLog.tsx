"use client";

import { useEffect, useRef } from "react";
import type { HistoryItem } from "@/app/components/types";

interface ConversationLogProps {
  history: HistoryItem[];
  loading: boolean;
}

export function ConversationLog({ history, loading }: ConversationLogProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history, loading]);

  return (
    <div className="h-64 overflow-y-auto rounded-lg border border-slate-700/80 bg-slate-950/70 p-3">
      <div className="space-y-2.5">
        {history.length === 0 ? (
          <p className="text-sm text-slate-400">Call not started yet.</p>
        ) : (
          history.map((line, index) => {
            const isNpc = line.role === "npc";
            return (
              <div
                key={`${line.role}-${index}`}
                className={`flex ${isNpc ? "justify-start" : "justify-end"}`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                    isNpc
                      ? "border border-cyan-400/35 bg-cyan-500/10 text-cyan-100"
                      : "border border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-100"
                  }`}
                >
                  <p className="mb-1 text-[10px] uppercase tracking-[0.15em] opacity-70">
                    {isNpc ? "NPC" : "Player"}
                  </p>
                  <p className="leading-relaxed">{line.content}</p>
                </div>
              </div>
            );
          })
        )}

        {loading ? (
          <div className="text-xs uppercase tracking-[0.14em] text-cyan-300">
            Unknown Caller is responding...
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
