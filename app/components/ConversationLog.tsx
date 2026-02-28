"use client";

import type { HistoryItem } from "@/app/components/types";

interface ConversationLogProps {
  history: HistoryItem[];
  loading: boolean;
  maxItems?: number;
}

export function ConversationLog({ history, loading, maxItems = 2 }: ConversationLogProps) {
  const visibleHistory = history.slice(-maxItems);

  return (
    <div className="min-h-[92px] rounded-2xl border border-cyan-400/25 bg-slate-950/80 p-3 md:min-h-[128px]">
      <div className="space-y-2">
        {visibleHistory.length === 0 ? (
          <p className="text-sm text-slate-400">Call not started yet.</p>
        ) : (
          visibleHistory.map((line, index) => {
            const isNpc = line.role === "npc";
            return (
              <div
                key={`${line.role}-${index}`}
                className={`flex ${isNpc ? "justify-start" : "justify-end"}`}
              >
                <div
                  className={`max-w-[92%] rounded-2xl px-3 py-2 text-sm ${
                    isNpc
                      ? "border border-cyan-400/45 bg-cyan-500/15 text-cyan-50"
                      : "border border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-50"
                  }`}
                >
                  <p className="mb-1 text-[10px] uppercase tracking-[0.15em] opacity-80">
                    {isNpc ? "NPC" : "You"}
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
      </div>
    </div>
  );
}
