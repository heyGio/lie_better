import { NextResponse } from "next/server";
import { createMistralTranscription } from "@/lib/mistral";
import { classifySpeechEmotion } from "@/lib/gemini-emotion";

export const runtime = "nodejs";

const MAX_AUDIO_MB = 20;
const MAX_AUDIO_BYTES = MAX_AUDIO_MB * 1024 * 1024;

function isRecoverableEmotionErrorMessage(raw: string | null | undefined) {
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return false;

  if (/no\s+pars(?:e)?able\s+response\s+content/i.test(normalized)) return true;
  if (normalized.includes("cannot extract voices from a non-audio request")) return true;
  if (normalized.includes("code 1007")) return true;

  return false;
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart/form-data payload." }, { status: 400 });
  }

  const audio = formData.get("audio");
  const languageRaw = formData.get("language");
  const analyzeEmotionRaw = formData.get("analyzeEmotion");
  const language = typeof languageRaw === "string" ? languageRaw.trim().slice(0, 12) : undefined;
  const analyzeEmotion =
    typeof analyzeEmotionRaw === "string" &&
    (analyzeEmotionRaw === "1" || analyzeEmotionRaw.toLowerCase() === "true");

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
    type: audio.type || "unknown",
    analyzeEmotion
  });

  try {
    const transcriptionPromise = createMistralTranscription({
      file: audio,
      language
    });
    let emotionError: string | null = null;
    const emotionPromise = analyzeEmotion
      ? classifySpeechEmotion(audio).catch((error) => {
          emotionError = error instanceof Error ? error.message : "Unknown emotion analysis error";
          if (isRecoverableEmotionErrorMessage(emotionError)) {
            console.info("ℹ️  [Emotion] Recoverable Gemini gap, transcript fallback remains active", {
              emotionError
            });
          } else {
            console.warn("⚠️  [Emotion] Speech emotion analysis skipped", { emotionError });
          }
          return null;
        })
      : Promise.resolve(null);

    const [transcription, emotion] = await Promise.all([transcriptionPromise, emotionPromise]);

    return NextResponse.json(
      {
        transcript: transcription.text,
        language: transcription.language,
        emotion: emotion?.label ?? null,
        emotionScore: typeof emotion?.score === "number" ? Number(emotion.score.toFixed(4)) : null,
        emotionScores: emotion?.scores ?? null,
        emotionModel: emotion?.model ?? null,
        emotionSource: emotion ? "gemini" : null,
        emotionError
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
