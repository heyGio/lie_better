interface TranscriptInputProps {
  value: string;
  disabled: boolean;
  helperText: string;
  onChange: (value: string) => void;
  onSend: () => void;
}

export function TranscriptInput({
  value,
  disabled,
  helperText,
  onChange,
  onSend
}: TranscriptInputProps) {
  return (
    <div className="space-y-2">
      <label className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-300">
        Transcript
      </label>
      <textarea
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Speak or type your line..."
        className="h-24 w-full resize-none rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-sm text-slate-100 outline-none ring-cyan-400 transition placeholder:text-slate-500 focus:ring-2"
      />
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <p className="text-xs text-slate-400">{helperText}</p>
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="rounded-lg bg-fuchsia-500 px-4 py-2 text-sm font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-fuchsia-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          Send Line
        </button>
      </div>
    </div>
  );
}
