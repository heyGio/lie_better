export function GameHeader() {
  return (
    <header className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-cyan-300 md:text-4xl">
          Lie Better: 120 Seconds
        </h1>
        <p className="text-sm text-slate-300">Voice persuasion thriller demo</p>
      </div>
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">
        Golden gAI
      </p>
    </header>
  );
}
