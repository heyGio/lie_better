interface TimerDisplayProps {
  timeRemaining: number;
  isDanger: boolean;
}

export function TimerDisplay({ timeRemaining, isDanger }: TimerDisplayProps) {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = String(timeRemaining % 60).padStart(2, "0");

  return (
    <div
      className={`panel flex items-center justify-between px-4 py-3 md:px-6 ${
        isDanger ? "danger-glow border-red-400/55" : ""
      }`}
    >
      <span className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-300">
        Countdown
      </span>
      <span
        className={`font-mono text-4xl font-extrabold tabular-nums md:text-5xl ${
          isDanger ? "text-red-400" : "text-cyan-300"
        }`}
      >
        {minutes}:{seconds}
      </span>
    </div>
  );
}
