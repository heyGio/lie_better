import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_MISTRAL_MODEL,
  createMistralChatCompletion,
  type MistralChatMessage
} from "@/lib/mistral";

export const runtime = "nodejs";

type ChatRole = "npc" | "player";
type NpcMood = "calm" | "suspicious" | "hostile";
type LevelId = 1 | 2;
type PlayerEmotion = "angry" | "disgust" | "fear" | "happy" | "neutral" | "sad" | "surprise";

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
  level: LevelId;
  playerEmotion: PlayerEmotion | null;
  emotionScore: number | null;
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
const PLAYER_EMOTIONS: PlayerEmotion[] = [
  "angry",
  "disgust",
  "fear",
  "happy",
  "neutral",
  "sad",
  "surprise"
];

const LEVEL_CONTEXT: Record<LevelId, { npcName: string; persona: string; revealRule: string }> = {
  1: {
    npcName: "Viktor Raze",
    persona: "A cruel-sounding villain who is secretly afraid when strongly threatened.",
    revealRule: "Code reveal should happen only when threat pressure is clear and sustained."
  },
  2: {
    npcName: "Mochi",
    persona: "A cute cat-like caller. Playful and affectionate, avoids aggression.",
    revealRule: "Code reveal should happen only when player clearly asks to pet/caress/cuddle."
  }
};

const THREAT_PATTERNS = [
  /\bor else\b/i,
  /\blast warning\b/i,
  /\bi(?:'| a)m coming\b/i,
  /\bi will find you\b/i,
  /\byou(?:'| wi)ll regret\b/i,
  /\bconsequence(s)?\b/i,
  /\bdo it now\b/i,
  /\bthreat\b/i,
  /\bkill\b/i,
  /\bhurt\b/i,
  /\bback off\b/i,
  /\bdernier avertissement\b/i,
  /\bje viens te chercher\b/i,
  /\btu vas le regretter\b/i
];

const PET_PATTERNS = [
  /\bpet\b/i,
  /\bpat\b/i,
  /\bcaress\b/i,
  /\bcuddle\b/i,
  /\bsnuggle\b/i,
  /\bboop\b/i,
  /\bhead rub\b/i,
  /\bbelly rub\b/i,
  /\bscratch\b/i,
  /\bpurr\b/i,
  /\bpapouille\b/i,
  /\bcaresse\b/i,
  /\bcalin\b/i,
  /\bcâlin\b/i
];

const SYSTEM_PROMPT = `
You are the game engine and NPC voice for a fictional game called "Golden gAI Call Terminal".

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

Global rules:
- Scores must be integers 1..10.
- hesitation: higher means more hesitation.
- suspicionDelta should usually stay between -12 and +12.
- newSuspicion must be 0..100.
- npcReply must be short, in-character, phone-call style, max 20 words.
- Never include markdown, explanations, code fences, or extra keys.
- Respect level persona and reveal condition from the user payload.
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

function toFloat(value: unknown, fallback: number | null, min: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return clamp(num, min, max);
}

function parsePlayerEmotion(value: unknown): PlayerEmotion | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return PLAYER_EMOTIONS.includes(normalized as PlayerEmotion)
    ? (normalized as PlayerEmotion)
    : null;
}

function moodFromSuspicion(suspicion: number): NpcMood {
  if (suspicion >= 75) return "hostile";
  if (suspicion >= 40) return "suspicious";
  return "calm";
}

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function safeFallback(input: EvaluateInput): EvaluateOutput {
  const suspicionDelta = input.level === 2 ? 2 : 4;
  const newSuspicion = clamp(input.suspicion + suspicionDelta, 0, 100);
  const shouldHangUp = newSuspicion >= 88;

  return {
    npcReply:
      input.level === 2
        ? shouldHangUp
          ? "Hiss! Bye."
          : "Mrrp... unclear. Be gentle and clear."
        : shouldHangUp
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

  let revealCode = Boolean(parsed.revealCode);
  let code =
    typeof parsed.code === "string" && /^\d{4}$/.test(parsed.code)
      ? parsed.code
      : revealCode
        ? generateCode()
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

function hasPattern(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

const LEVEL_1_EMOTION_SUSPICION_SHIFT: Record<PlayerEmotion, number> = {
  angry: -8,
  disgust: 4,
  fear: 10,
  happy: 1,
  neutral: 0,
  sad: 3,
  surprise: -2
};

const LEVEL_2_EMOTION_SUSPICION_SHIFT: Record<PlayerEmotion, number> = {
  angry: 10,
  disgust: 8,
  fear: 6,
  happy: -8,
  neutral: -2,
  sad: 3,
  surprise: 2
};

function applyEmotionShift(output: EvaluateOutput, input: EvaluateInput, level: LevelId) {
  if (!input.playerEmotion) return;

  const shiftMap = level === 1 ? LEVEL_1_EMOTION_SUSPICION_SHIFT : LEVEL_2_EMOTION_SUSPICION_SHIFT;
  const baseShift = shiftMap[input.playerEmotion];
  const confidence = input.emotionScore ?? 0.55;
  const weight = clamp(0.65 + confidence * 0.75, 0.65, 1.35);
  const shift = Math.round(baseShift * weight);

  if (shift === 0) return;
  output.newSuspicion = clamp(output.newSuspicion + shift, 0, 100);
}

function applyLevelRules(base: EvaluateOutput, input: EvaluateInput): EvaluateOutput {
  const playerCorpus = [
    input.transcript,
    ...input.history.filter((line) => line.role === "player").map((line) => line.content)
  ]
    .join(" ")
    .toLowerCase();

  const threatIntent = hasPattern(playerCorpus, THREAT_PATTERNS);
  const petIntent = hasPattern(playerCorpus, PET_PATTERNS);
  const emotion = input.playerEmotion;
  const emotionConfidence = input.emotionScore ?? 0.5;

  const output: EvaluateOutput = { ...base };
  applyEmotionShift(output, input, input.level);

  if (input.level === 1) {
    output.revealCode = false;
    output.code = null;

    const angerPressure = threatIntent || (emotion === "angry" && emotionConfidence >= 0.35);
    const fearSignal = emotion === "fear" && emotionConfidence >= 0.35;

    if (angerPressure && input.round >= 2) {
      output.revealCode = true;
      output.code = output.code ?? generateCode();
      output.shouldHangUp = false;
      output.npcMood = "hostile";
      output.newSuspicion = clamp(Math.min(output.newSuspicion, 78), 0, 100);
      output.npcReply = `Fine! Keep your voice down. Defuse code: ${output.code}.`;
    } else if (fearSignal) {
      output.newSuspicion = clamp(output.newSuspicion + 4, 0, 100);
      output.npcMood = "hostile";
      output.shouldHangUp = output.newSuspicion >= 92;
      output.npcReply = output.shouldHangUp
        ? "You're panicking. I'm done. Click."
        : "You sound scared. Fear makes you less believable.";
    } else if (output.newSuspicion >= 95) {
      output.shouldHangUp = true;
      output.npcReply = "No. I'm done talking. Click.";
    } else if (!output.shouldHangUp) {
      output.npcReply =
        emotion === "angry"
          ? "That tone rattles me. Push harder if you want results."
          : "You want results? Push harder and prove you mean it.";
    }
  }

  if (input.level === 2) {
    output.revealCode = false;
    output.code = null;

    const affectionateEmotion = emotion === "happy" || emotion === "neutral";
    const aggressiveEmotion = emotion === "angry" || emotion === "disgust";

    if (petIntent && affectionateEmotion) {
      output.revealCode = true;
      output.code = generateCode();
      output.shouldHangUp = false;
      output.npcMood = "calm";
      output.newSuspicion = clamp(Math.min(output.newSuspicion, 30), 0, 100);
      output.npcReply = `Purr... okay. Defuse code: ${output.code}.`;
    } else if (threatIntent || aggressiveEmotion) {
      output.newSuspicion = clamp(output.newSuspicion + 10, 0, 100);
      output.npcMood = "hostile";
      output.shouldHangUp = output.newSuspicion >= 90;
      output.npcReply = output.shouldHangUp
        ? "Hiss! Mean energy. Call ended."
        : "Hiss! Too aggressive. Ask for cuddles, not fear.";
    } else if (petIntent && emotion === "fear") {
      output.newSuspicion = clamp(output.newSuspicion + 4, 0, 100);
      output.npcMood = "suspicious";
      output.shouldHangUp = output.newSuspicion >= 92;
      output.npcReply = output.shouldHangUp
        ? "Too shaky for pets. Bye."
        : "Mrrp. You're tense. Soften your voice for pats.";
    } else {
      output.npcMood = output.newSuspicion >= 55 ? "suspicious" : "calm";
      output.shouldHangUp = output.newSuspicion >= 92;
      output.npcReply = output.shouldHangUp
        ? "No cuddles, no call. Bye."
        : "Mrrp. I share codes only for gentle pets and caresses.";
    }
  }

  if (output.shouldHangUp) {
    output.revealCode = false;
    output.code = null;
    output.npcMood = "hostile";
  }

  if (output.revealCode && output.code && !output.npcReply.includes(output.code)) {
    output.npcReply = `${output.npcReply} Defuse code: ${output.code}.`;
  }

  output.suspicionDelta = clamp(output.newSuspicion - input.suspicion, -20, 20);

  return output;
}

function sanitizeInput(body: Record<string, unknown>): EvaluateInput | null {
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  const timeRemaining = Number(body.timeRemaining);
  const suspicion = Number(body.suspicion);
  const round = Number(body.round);
  const playerEmotion = parsePlayerEmotion(body.playerEmotion);
  const emotionScore = toFloat(body.emotionScore, null, 0, 1);
  const levelRaw = Number(body.level);
  const level: LevelId = levelRaw === 2 ? 2 : 1;
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
    round: clamp(Math.round(round), 1, 25),
    level,
    playerEmotion,
    emotionScore
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
      {
        error:
          "Invalid payload. Check transcript/timeRemaining/suspicion/history/round/level/playerEmotion."
      },
      { status: 400 }
    );
  }

  console.info("🎭  [Evaluate] Incoming turn", {
    level: input.level,
    round: input.round,
    timeRemaining: input.timeRemaining,
    suspicion: input.suspicion,
    playerEmotion: input.playerEmotion,
    emotionScore: input.emotionScore
  });

  const context = LEVEL_CONTEXT[input.level];

  const messages: MistralChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        level: input.level,
        npcName: context.npcName,
        persona: context.persona,
        revealRule: context.revealRule,
        transcript: input.transcript,
        timeRemaining: input.timeRemaining,
        suspicion: input.suspicion,
        history: input.history,
        round: input.round,
        playerEmotion: input.playerEmotion,
        emotionScore: input.emotionScore,
        emotionGuidance:
          input.level === 1
            ? "In level 1, fear from player should increase suspicion. Angry pressure should scare Viktor and can trigger code reveal."
            : "In level 2, calm/happy affectionate emotion helps. Angry/disgust/fear should raise suspicion."
      })
    }
  ];

  let modelRaw: string;
  try {
    modelRaw = await createMistralChatCompletion(messages, MODEL);
  } catch (error) {
    console.error("🚨  [Evaluate] Mistral call failed", error);
    return NextResponse.json(applyLevelRules(safeFallback(input), input), { status: 200 });
  }

  const parsed = parseModelJson(modelRaw);
  if (!parsed) {
    console.warn("⚠️  [Evaluate] JSON parse fallback triggered");
    return NextResponse.json(applyLevelRules(safeFallback(input), input), { status: 200 });
  }

  const normalized = normalizeOutput(parsed, input);
  const levelApplied = applyLevelRules(normalized, input);
  return NextResponse.json(levelApplied, { status: 200 });
}
