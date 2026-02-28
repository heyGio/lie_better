interface PushToTalkProps {
  disabled: boolean;
  isRecording: boolean;
  onPressStart: () => void;
  onPressEnd: () => void;
}

export function PushToTalk({
  disabled,
  isRecording,
  onPressStart,
  onPressEnd
}: PushToTalkProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(event) => {
        event.preventDefault();
        onPressStart();
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        onPressEnd();
      }}
      onPointerCancel={() => {
        if (isRecording) onPressEnd();
      }}
      onPointerLeave={() => {
        if (isRecording) onPressEnd();
      }}
      className={`w-full rounded-xl px-4 py-3 text-base font-bold uppercase tracking-[0.17em] transition ${
        disabled
          ? "cursor-not-allowed bg-slate-700/80 text-slate-300"
          : isRecording
            ? "bg-red-500 text-white shadow-[0_0_24px_rgba(239,68,68,0.45)]"
            : "bg-cyan-500 text-slate-950 hover:bg-cyan-400"
      }`}
      style={{ touchAction: "none" }}
    >
      {isRecording ? "Release to Send" : "Push to Talk"}
    </button>
  );
}
