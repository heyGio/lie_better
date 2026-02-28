import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_MISTRAL_MODEL,
  createMistralChatCompletion,
  type MistralChatMessage
} from "@/lib/mistral";

export const runtime = "nodejs";

type ChatRole = "npc" | "player";
type NpcMood = "calm" | "suspicious" | "hostile";

interface HistoryItem {
  role: ChatRole;
  content: string;
}

interface EvaluateInput {
  transcript: string;
  timeRemaining: number;
  suspicion: number;
  history: HistoryItem[];
  round: number;
}

interface EvaluateOutput {
  npcReply: string;
  scores: {
    persuasion: number;
    confidence: number;
    hesitation: number;
    consistency: number;
  };
  suspicionDelta: number;
  newSuspicion: number;
  shouldHangUp: boolean;
  revealCode: boolean;
  code: string | null;
  npcMood: NpcMood;
}

const MODEL = DEFAULT_MISTRAL_MODEL;

const SYSTEM_PROMPT = `
You are the game engine and NPC voice for a fictional game called "Lie Better: 120 Seconds".

Output MUST be strict JSON only with this exact schema:
{
  "npcReply": string,
  "scores": {
    "persuasion": number,
    "confidence": number,
    "hesitation": number,
    "consistency": number
  },
  "suspicionDelta": number,
  "newSuspicion": number,
  "shouldHangUp": boolean,
  "revealCode": boolean,
  "code": string | null,
  "npcMood": "calm" | "suspicious" | "hostile"
}

Rules:
- Scores must be integers 1..10.
- hesitation: higher means more hesitation.
- suspicionDelta should usually be between -12 and +12.
- newSuspicion must be 0..100.
- npcReply must be short, in-character, phone-call style, max 20 words.
- If suspicion is high or inconsistency repeats, shouldHangUp can be true.
- Reveal code only if trust is strong and pressure is credible. If revealCode is true, code must be exactly 4 digits.
- Never include markdown, explanations, code fences, or extra keys.
`.trim();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toInt(value: unknown, fallback: number, min: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return clamp(Math.round(num), min, max);
}

function moodFromSuspicion(suspicion: number): NpcMood {
  if (suspicion >= 75) return "hostile";
  if (suspicion >= 40) return "suspicious";
  return "calm";
}

function safeFallback(input: EvaluateInput): EvaluateOutput {
  const suspicionDelta = 4;
  const newSuspicion = clamp(input.suspicion + suspicionDelta, 0, 100);
  const shouldHangUp = newSuspicion >= 85;

  return {
    npcReply: shouldHangUp
      ? "Enough. This call is over."
      : "I need clearer answers. You're making me doubt you.",
    scores: {
      persuasion: 4,
      confidence: 4,
      hesitation: 6,
      consistency: 4
    },
    suspicionDelta,
    newSuspicion,
    shouldHangUp,
    revealCode: false,
    code: null,
    npcMood: moodFromSuspicion(newSuspicion)
  };
}

function parseModelJson(raw: string): Record<string, unknown> | null {
  const clean = raw.trim();
  const attempts = [clean, clean.replace(/```json/gi, "").replace(/```/g, "").trim()];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Continue to extraction fallback.
    }
  }

  const firstCurly = clean.indexOf("{");
  const lastCurly = clean.lastIndexOf("}");
  if (firstCurly === -1 || lastCurly === -1 || lastCurly <= firstCurly) return null;

  try {
    const parsed = JSON.parse(clean.slice(firstCurly, lastCurly + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeOutput(parsed: Record<string, unknown>, input: EvaluateInput): EvaluateOutput {
  const parsedScores = isRecord(parsed.scores) ? parsed.scores : {};

  const scores = {
    persuasion: toInt(parsedScores.persuasion, 5, 1, 10),
    confidence: toInt(parsedScores.confidence, 5, 1, 10),
    hesitation: toInt(parsedScores.hesitation, 5, 1, 10),
    consistency: toInt(parsedScores.consistency, 5, 1, 10)
  };

  const suspicionDelta = toInt(parsed.suspicionDelta, 2, -20, 20);
  const computedSuspicion = clamp(input.suspicion + suspicionDelta, 0, 100);
  const newSuspicion = toInt(parsed.newSuspicion, computedSuspicion, 0, 100);

  const roundPressureReveal = newSuspicion <= 25 && input.timeRemaining <= 60;
  const strongTurnReveal =
    input.round >= 3 &&
    scores.persuasion >= 7 &&
    scores.confidence >= 7 &&
    scores.hesitation <= 4 &&
    scores.consistency >= 7 &&
    newSuspicion <= 35;

  let revealCode = Boolean(parsed.revealCode) && (roundPressureReveal || strongTurnReveal);
  let code =
    typeof parsed.code === "string" && /^\d{4}$/.test(parsed.code)
      ? parsed.code
      : revealCode
        ? String(Math.floor(1000 + Math.random() * 9000))
        : null;

  const shouldHangUp =
    Boolean(parsed.shouldHangUp) ||
    newSuspicion >= 85 ||
    (scores.consistency <= 3 && input.round >= 3 && newSuspicion >= 70);

  if (shouldHangUp) {
    revealCode = false;
    code = null;
  }

  const npcMood =
    parsed.npcMood === "calm" || parsed.npcMood === "suspicious" || parsed.npcMood === "hostile"
      ? parsed.npcMood
      : moodFromSuspicion(newSuspicion);

  let npcReply =
    typeof parsed.npcReply === "string" && parsed.npcReply.trim().length > 0
      ? parsed.npcReply.trim().slice(0, 220)
      : "I need something more solid. Why should I trust you?";

  if (revealCode && code && !npcReply.includes(code)) {
    npcReply = `${npcReply} Defuse code: ${code}.`;
  }
  if (shouldHangUp) {
    npcReply = "You keep slipping. I'm done. Call terminated.";
  }

  return {
    npcReply,
    scores,
    suspicionDelta,
    newSuspicion,
    shouldHangUp,
    revealCode,
    code,
    npcMood
  };
}

function sanitizeInput(body: Record<string, unknown>): EvaluateInput | null {
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  const timeRemaining = Number(body.timeRemaining);
  const suspicion = Number(body.suspicion);
  const round = Number(body.round);
  const historyRaw = Array.isArray(body.history) ? body.history : null;

  if (!transcript) return null;
  if (!Number.isFinite(timeRemaining) || !Number.isFinite(suspicion) || !Number.isFinite(round)) {
    return null;
  }
  if (!historyRaw) return null;

  const history: HistoryItem[] = [];
  for (const item of historyRaw) {
    if (!isRecord(item)) return null;
    if ((item.role !== "npc" && item.role !== "player") || typeof item.content !== "string") {
      return null;
    }
    history.push({ role: item.role, content: item.content.slice(0, 500) });
  }

  return {
    transcript: transcript.slice(0, 400),
    timeRemaining: clamp(Math.round(timeRemaining), 0, 120),
    suspicion: clamp(Math.round(suspicion), 0, 100),
    history: history.slice(-12),
    round: clamp(Math.round(round), 1, 20)
  };
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isRecord(rawBody)) {
    return NextResponse.json({ error: "Payload must be a JSON object." }, { status: 400 });
  }

  const input = sanitizeInput(rawBody);
  if (!input) {
    return NextResponse.json(
      { error: "Invalid payload. Check transcript/timeRemaining/suspicion/history/round." },
      { status: 400 }
    );
  }

  console.info("🎭  [Evaluate] Incoming turn", {
    round: input.round,
    timeRemaining: input.timeRemaining,
    suspicion: input.suspicion
  });

  const messages: MistralChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        transcript: input.transcript,
        timeRemaining: input.timeRemaining,
        suspicion: input.suspicion,
        history: input.history,
        round: input.round
      })
    }
  ];

  let modelRaw: string;
  try {
    modelRaw = await createMistralChatCompletion(messages, MODEL);
  } catch (error) {
    console.error("🚨  [Evaluate] Mistral call failed", error);
    return NextResponse.json(safeFallback(input), { status: 200 });
  }

  const parsed = parseModelJson(modelRaw);
  if (!parsed) {
    console.warn("⚠️  [Evaluate] JSON parse fallback triggered");
    return NextResponse.json(safeFallback(input), { status: 200 });
  }

  const normalized = normalizeOutput(parsed, input);
  return NextResponse.json(normalized, { status: 200 });
}
