import { NextRequest, NextResponse } from "next/server";
import {
  synthesizeWithElevenLabs,
  synthesizeWithElevenLabsStream,
  type ElevenLabsVoiceSettings,
  DEFAULT_ELEVENLABS_VOICE_LEVEL_2
} from "@/lib/elevenlabs";

export const runtime = "nodejs";

type NpcMood = "calm" | "suspicious" | "hostile";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseMood(value: unknown): NpcMood {
  return value === "calm" || value === "hostile" ? value : "suspicious";
}

function buildVillainVoiceSettings({
  suspicion,
  mood
}: {
  suspicion: number;
  mood: NpcMood;
}): ElevenLabsVoiceSettings {
  const normalizedSuspicion = clamp(Math.round(suspicion), 0, 100);

  if (normalizedSuspicion >= 80 || mood === "hostile") {
    return {
      stability: 0.14,
      similarity_boost: 0.83,
      style: 0.85,
      use_speaker_boost: true
    };
  }

  if (normalizedSuspicion >= 60 || mood === "suspicious") {
    return {
      stability: 0.23,
      similarity_boost: 0.8,
      style: 0.6,
      use_speaker_boost: true
    };
  }

  return {
    stability: 0.42,
    similarity_boost: 0.74,
    style: 0.2,
    use_speaker_boost: true
  };
}

function validateTtsInput(text: string, level: number) {
  if (!text) {
    return "Missing text.";
  }
  if (level !== 1 && level !== 2) {
    // Voice mode is currently enabled only for Level 1 and Level 2
    return "TTS is disabled for this level.";
  }
  return null;
}

export async function GET(request: NextRequest) {
  const text = request.nextUrl.searchParams.get("text")?.trim() ?? "";
  const level = Number(request.nextUrl.searchParams.get("level") ?? "1");
  const suspicion = Number(request.nextUrl.searchParams.get("suspicion") ?? "50");
  const mood = parseMood(request.nextUrl.searchParams.get("mood"));

  const validationError = validateTtsInput(text, level);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  console.info("🔊  [TTS] Streaming NPC voice", {
    level,
    chars: text.length,
    suspicion: Number.isFinite(suspicion) ? clamp(suspicion, 0, 100) : 50,
    mood
  });

  try {
    const streamResult = await synthesizeWithElevenLabsStream({
      text,
      voiceId: level === 2 ? DEFAULT_ELEVENLABS_VOICE_LEVEL_2 : undefined,
      voiceSettings: buildVillainVoiceSettings({
        suspicion: Number.isFinite(suspicion) ? suspicion : 50,
        mood
      })
    });

    return new NextResponse(streamResult.stream, {
      status: 200,
      headers: {
        "Content-Type": streamResult.contentType,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("🚨  [TTS] ElevenLabs stream synthesis failed", error);
    return NextResponse.json(
      {
        error: "Failed to synthesize voice stream.",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isRecord(body)) {
    return NextResponse.json({ error: "Payload must be a JSON object." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const level = Number(body.level);
  const suspicion = Number(body.suspicion);
  const mood = parseMood(body.mood);

  const validationError = validateTtsInput(text, level);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  console.info("🔊  [TTS] Synthesizing NPC voice", {
    level,
    chars: text.length,
    suspicion: Number.isFinite(suspicion) ? clamp(suspicion, 0, 100) : 50,
    mood
  });

  try {
    const result = await synthesizeWithElevenLabs({
      text,
      voiceId: level === 2 ? DEFAULT_ELEVENLABS_VOICE_LEVEL_2 : undefined,
      voiceSettings: buildVillainVoiceSettings({
        suspicion: Number.isFinite(suspicion) ? suspicion : 50,
        mood
      })
    });

    return new NextResponse(result.audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("🚨  [TTS] ElevenLabs synthesis failed", error);
    return NextResponse.json(
      {
        error: "Failed to synthesize voice.",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 502 }
    );
  }
}
