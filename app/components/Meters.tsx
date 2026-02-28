interface MetersProps {
  suspicion: number;
}

function barColorFromSuspicion(value: number) {
  if (value >= 75) return "bg-red-500";
  if (value >= 45) return "bg-amber-500";
  return "bg-emerald-500";
}

function trustColorFromValue(value: number) {
  if (value >= 70) return "bg-cyan-400";
  if (value >= 40) return "bg-sky-500";
  return "bg-slate-500";
}

export function Meters({ suspicion }: MetersProps) {
  const trust = Math.max(0, 100 - suspicion);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-slate-300">
          <span>Suspicion</span>
          <span>{suspicion}</span>
        </div>
        <div className="h-3 rounded-full bg-slate-800">
          <div
            className={`h-full rounded-full transition-all ${barColorFromSuspicion(suspicion)}`}
            style={{ width: `${suspicion}%` }}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-slate-300">
          <span>Trust</span>
          <span>{trust}</span>
        </div>
        <div className="h-3 rounded-full bg-slate-800">
          <div
            className={`h-full rounded-full transition-all ${trustColorFromValue(trust)}`}
            style={{ width: `${trust}%` }}
          />
        </div>
      </div>
    </div>
  );
}
