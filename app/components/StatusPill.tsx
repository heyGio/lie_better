import type { NpcMood } from "@/app/components/types";

interface StatusPillProps {
  mood: NpcMood;
}

const LABELS: Record<NpcMood, string> = {
  calm: "calm",
  suspicious: "suspicious",
  hostile: "hostile"
};

const STYLE: Record<NpcMood, string> = {
  calm: "bg-emerald-500/20 text-emerald-300 border-emerald-400/40",
  suspicious: "bg-amber-500/20 text-amber-300 border-amber-400/40",
  hostile: "bg-red-500/20 text-red-300 border-red-400/50"
};

export function StatusPill({ mood }: StatusPillProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.15em] ${STYLE[mood]}`}
    >
      {LABELS[mood]}
    </span>
  );
}
