import { NextResponse } from "next/server";
import { createMistralTranscription } from "@/lib/mistral";

export const runtime = "nodejs";

const MAX_AUDIO_MB = 20;
const MAX_AUDIO_BYTES = MAX_AUDIO_MB * 1024 * 1024;

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart/form-data payload." }, { status: 400 });
  }

  const audio = formData.get("audio");
  const languageRaw = formData.get("language");
  const language = typeof languageRaw === "string" ? languageRaw.trim().slice(0, 12) : undefined;

  if (!(audio instanceof File)) {
    return NextResponse.json({ error: "Missing audio file in 'audio' field." }, { status: 400 });
  }

  if (audio.size === 0) {
    return NextResponse.json({ error: "Audio file is empty." }, { status: 400 });
  }

  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: `Audio file too large. Max allowed is ${MAX_AUDIO_MB}MB.` },
      { status: 413 }
    );
  }

  console.info("🎙️  [Transcribe] Incoming audio", {
    bytes: audio.size,
    type: audio.type || "unknown"
  });

  try {
    const result = await createMistralTranscription({
      file: audio,
      language
    });

    return NextResponse.json(
      {
        transcript: result.text,
        language: result.language
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("🚨  [Transcribe] Mistral transcription failed", error);
    return NextResponse.json(
      { error: "Failed to transcribe audio with Mistral.", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}
