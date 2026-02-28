interface CodeEntryProps {
  codeKnown: boolean;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onDefuse: () => void;
}

export function CodeEntry({
  codeKnown,
  value,
  disabled,
  onChange,
  onDefuse
}: CodeEntryProps) {
  if (!codeKnown) return null;

  return (
    <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-emerald-300">
        Defuse code received
      </p>
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          maxLength={4}
          placeholder="0000"
          className="w-full rounded-lg border border-emerald-400/35 bg-slate-900/80 p-3 text-center font-mono text-2xl tracking-[0.3em] text-emerald-200 outline-none ring-emerald-400 transition focus:ring-2 md:w-56"
        />
        <button
          type="button"
          onClick={onDefuse}
          disabled={disabled || value.length !== 4}
          className="rounded-lg bg-emerald-500 px-5 py-3 text-sm font-bold uppercase tracking-[0.15em] text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          Defuse
        </button>
      </div>
    </div>
  );
}
