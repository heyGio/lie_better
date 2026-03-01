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
  stage: number;
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
  stage: number;
  nextStage: number;
  passStage: boolean;
  failureReason: string | null;
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

const FINAL_STAGE = 4;
const MAX_TIME_SECONDS = 120;
const LEVEL1_STAGE_OBJECTIVES: Record<number, string> = {
  1: "Tutorial kickoff. Player gives any initial line after NPC demands to be convinced for the code.",
  2: "NPC pressures the player to sound sad. Progress only when detected emotion is sad.",
  3: "NPC taunts the player. Progress only when detected emotion is angry.",
  4: "NPC starts breaking. Player must sound angry again to crack NPC and reveal the 4-digit code."
};

const LEVEL1_STAGE_HINTS: Record<number, string> = {
  1: "Say one clear opening line.",
  2: "Let me hear sadness in your voice.",
  3: "Reply with anger in your voice.",
  4: "Push again with anger so I crack and give the code."
};

const LEVEL1_STAGE_GUIDANCE_PATTERNS: Record<number, RegExp[]> = {
  1: [/\b(say|speak|talk)\b/i, /\b(opening|line|clear)\b/i],
  2: [/\b(sad|sadness|upset|hurt|broken|teary|cry|crying)\b/i, /\b(let me hear|sound)\b/i],
  3: [/\b(angry|anger|rage|mad)\b/i, /\b(voice|sound|say)\b/i],
  4: [/\b(angry|anger|rage|mad)\b/i, /\b(again|harder|push)\b/i]
};

const GENERIC_GUIDANCE_PATTERNS: RegExp[] = [
  /\b(start with|start by)\b/i,
  /\b(say|ask|offer|threaten|demand)\b/i,
  /\b(let me hear|in your voice|sound)\b/i,
  /\b(scared|afraid|fear|sad|sadness|upset|teary|angry|anger|rage|mad)\b/i,
  /\b(tell me|give me)\b/i,
  /\b(if you want progress|to move forward|to advance)\b/i
];

const USED_NPC_REPLIES = new Set<string>();
const USED_NPC_REPLIES_QUEUE: string[] = [];
const MAX_TRACKED_REPLIES = 300;

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
  /\bback off\b/i
];

const PET_PATTERNS = [
  /\bpet\b/i,
  /\bpats?\b/i,
  /\bcaress\b/i,
  /\bcuddles?\b/i,
  /\bsnuggle\b/i,
  /\bboop\b/i,
  /\bhead rub\b/i,
  /\bbelly rub\b/i,
  /\bscratch\b/i,
  /\bpurr\b/i
];

interface LevelContextConfig {
  npcName: string;
  persona: string;
  revealRule: string;
  emotionGuidance: string;
}

interface LevelRuleConfig {
  context: LevelContextConfig;
  emotionShift: Record<PlayerEmotion, number>;
  revealMinRound: number;
  revealSuspicionCap: number;
  forcedHangupSuspicion: number;
}

const LEVEL_RULES: Record<LevelId, LevelRuleConfig> = {
  1: {
    context: {
      npcName: "Viktor Raze",
      persona:
        "A manipulative villain who uses emotional pressure. He escalates from intimidation to taunting, then cracks under sustained anger.",
      revealRule:
        "Code reveal should happen only at stage 4 after the player is detected as angry for a second time in this tutorial flow.",
      emotionGuidance:
        "Level 1 tutorial sequence is strict: stage 2 needs sad, stage 3 needs angry, stage 4 needs angry again to reveal code."
    },
    emotionShift: {
      angry: -8,
      disgust: 4,
      fear: 3,
      happy: 1,
      neutral: 0,
      sad: 10,
      surprise: -2
    },
    revealMinRound: 2,
    revealSuspicionCap: 78,
    forcedHangupSuspicion: 95
  },
  2: {
    context: {
      npcName: "Mochi",
      persona: "A playful, cute street cat in Shibuya. She stole the player's Suica card. She responds well to emotional vulnerability (sadness) and joy (happiness).",
      revealRule: "Return the Suica card (revealCode) ONLY at stage 3 when the player asks to pet her after having built trust.",
      emotionGuidance:
        "In level 2, happy and sad emotions build trust. Stage 1 requires lowering suspicion below 25. Stage 2 requires asking to pet her."
    },
    emotionShift: {
      angry: 12,
      disgust: 8,
      fear: 4,
      happy: -15, // Joy builds trust rapidly
      neutral: -2,
      sad: -12, // Vulnerability makes her want to help
      surprise: 0
    },
    revealMinRound: 2,
    revealSuspicionCap: 25,
    forcedHangupSuspicion: 92
  }
};

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
  "npcMood": "calm" | "suspicious" | "hostile",
  "stage": number,
  "nextStage": number,
  "passStage": boolean,
  "failureReason": string | null
}

Global rules:
- Scores must be integers 1..10.
- hesitation: higher means more hesitation.
- suspicionDelta should usually stay between -12 and +12.
- newSuspicion must be 0..100.
- npcReply must be short, in-character, phone-call style, max 22 words.
- Keep npcReply varied, story-driven, and slightly darkly witty.
- npcReply language MUST be English only.
- Never reuse a previous npcReply from conversation history.
- For level 1, progression is STRICT 4 stages. Never skip stages.
- If the player's line fails the current stage objective or is nonsense/off-topic, set:
  passStage=false, nextStage=stage, revealCode=false, code=null.
- If passStage=false and stageHint is provided in payload, npcReply must include that guidance naturally in the same line.
- On failed stage, npcReply must mock the player briefly and force a retry (no instant detonation).
- npcReply must combine: (1) in-character reaction + (2) actionable next step guidance.
- Use only one concise guidance instruction; never repeat the same instruction with different wording.
- Never use labels like "Hint:" or "Tip:".
- Never wrap words with asterisks (no *action* style markers).
- Only if stage 4 is passed can revealCode be true.
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
  const suspicionDelta = input.level === 2 ? 2 : 3;
  const newSuspicion = clamp(input.suspicion + suspicionDelta, 0, 100);
  const shouldHangUp = false;

  return {
    npcReply:
      input.level === 2
        ? "Miao... signal glitch. Say it again clearly."
        : "Line glitch. Repeat your line, sharper.",
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
    npcMood: moodFromSuspicion(newSuspicion),
    stage: clamp(input.stage, 1, FINAL_STAGE),
    nextStage: clamp(input.stage, 1, FINAL_STAGE),
    passStage: false,
    failureReason: null
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

function normalizeReplyKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectBannedReplyKeys(input: EvaluateInput) {
  const keys = new Set<string>();
  for (const line of input.history) {
    if (line.role !== "npc") continue;
    const key = normalizeReplyKey(line.content);
    if (key) keys.add(key);
  }
  for (const key of USED_NPC_REPLIES) {
    keys.add(key);
  }
  return keys;
}

function rememberNpcReply(reply: string) {
  const key = normalizeReplyKey(reply);
  if (!key || USED_NPC_REPLIES.has(key)) return;

  USED_NPC_REPLIES.add(key);
  USED_NPC_REPLIES_QUEUE.push(key);

  if (USED_NPC_REPLIES_QUEUE.length > MAX_TRACKED_REPLIES) {
    const oldest = USED_NPC_REPLIES_QUEUE.shift();
    if (oldest) USED_NPC_REPLIES.delete(oldest);
  }
}

function withUniqueSuffix(reply: string, bannedKeys: Set<string>) {
  const suffixes = [
    "Clock's bleeding.",
    "Still stuck.",
    "No progress yet.",
    "Try again, sharper.",
    "Seconds are dying.",
    "Not even close.",
    "Move. Now."
  ];

  for (let i = 0; i < suffixes.length; i += 1) {
    const candidate = `${reply} ${suffixes[(i + Math.floor(Math.random() * suffixes.length)) % suffixes.length]}`.trim();
    const key = normalizeReplyKey(candidate);
    if (!bannedKeys.has(key)) return candidate;
  }

  return `${reply} ${Date.now().toString().slice(-4)}`;
}

function normalizeGuidance(hint: string) {
  const clean = hint.trim().replace(/[.!?]+$/, "");
  if (!clean) return "say it clearly and stay on point";
  return clean.charAt(0).toLowerCase() + clean.slice(1);
}

function hasIntegratedGuidance(reply: string, stage: number) {
  const patterns = LEVEL1_STAGE_GUIDANCE_PATTERNS[clamp(stage, 1, FINAL_STAGE)] ?? [];
  const lower = reply.toLowerCase();
  return patterns.some((pattern) => pattern.test(lower));
}

function hasActionableGuidance(reply: string) {
  const lower = reply.toLowerCase();
  return GENERIC_GUIDANCE_PATTERNS.some((pattern) => pattern.test(lower));
}

function appendIntegratedGuidance(reply: string, hint: string) {
  const guidance = normalizeGuidance(hint);
  const trimmed = reply.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  return `${trimmed}. If you want progress, ${guidance}.`;
}

function localFailFallback(input: EvaluateInput, bannedKeys: Set<string>) {
  const hint =
    input.level === 1
      ? LEVEL1_STAGE_HINTS[clamp(input.stage, 1, FINAL_STAGE)] ?? "Give a clearer line."
      : "Give a clearer line.";
  const words = input.transcript.trim().split(/\s+/).slice(0, 5).join(" ");
  const base = words
    ? `You said "${words}"? That won't move stage ${input.stage}.`
    : `That won't move stage ${input.stage}.`;
  const line = appendIntegratedGuidance(base, hint);
  const key = normalizeReplyKey(line);
  return bannedKeys.has(key) ? withUniqueSuffix(line, bannedKeys) : line;
}

async function generateUniqueNpcReplyWithLlm({
  input,
  output,
  bannedKeys
}: {
  input: EvaluateInput;
  output: EvaluateOutput;
  bannedKeys: Set<string>;
}): Promise<string | null> {
  const levelContext = LEVEL_RULES[input.level].context;
  const stageHint =
    input.level === 1
      ? LEVEL1_STAGE_HINTS[clamp(input.stage, 1, FINAL_STAGE)] ?? "Give a clearer line."
      : "Give a clearer line.";
  const avoidReplies = input.history
    .filter((line) => line.role === "npc")
    .slice(-8)
    .map((line) => line.content);

  const messages: MistralChatMessage[] = [
    {
      role: "system",
      content: [
        "Write ONE short NPC phone-call line.",
        "English only.",
        "No markdown.",
        "No asterisks around words.",
        "Max 20 words.",
        "If passStage=false, include BOTH: a reaction and the stageHint guidance in the same line.",
        "Guidance must be explicit and actionable, not vague.",
        "Include only one guidance instruction. Do not restate the same guidance twice.",
        "Never use labels like 'Hint:' or 'Tip:'.",
        "Return strict JSON: {\"reply\": string}."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        persona: levelContext.persona,
        transcript: input.transcript,
        stage: input.stage,
        passStage: output.passStage,
        revealCode: output.revealCode,
        failureReason: output.failureReason,
        mustConvey:
          input.level === 1 && !output.passStage
            ? "Player is stuck at same stage; mock lightly, show no progress, and include reaction + actionable stage guidance in one line."
            : "Advance story in character.",
        stageHint,
        avoidReplies,
        randomSeed: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      })
    }
  ];

  try {
    const raw = await createMistralChatCompletion(messages, MODEL);
    const parsed = parseModelJson(raw);
    if (!parsed) return null;

    const reply = typeof parsed.reply === "string" ? parsed.reply.trim().slice(0, 220) : "";
    if (!reply) return null;

    const key = normalizeReplyKey(reply);
    if (!key || bannedKeys.has(key)) return null;
    return reply;
  } catch {
    return null;
  }
}

async function enforceReplyPolicies(output: EvaluateOutput, input: EvaluateInput): Promise<EvaluateOutput> {
  const patched: EvaluateOutput = { ...output };
  const bannedKeys = collectBannedReplyKeys(input);
  const stageHint =
    input.level === 1
      ? LEVEL1_STAGE_HINTS[clamp(input.stage, 1, FINAL_STAGE)] ?? "Give a clearer line."
      : "Give a clearer line.";

  const currentKey = normalizeReplyKey(patched.npcReply);
  const duplicate = currentKey ? bannedKeys.has(currentKey) : true;
  const needFailTaunt = input.level === 1 && !patched.passStage && !patched.revealCode;

  if (needFailTaunt || duplicate) {
    const llmReply = await generateUniqueNpcReplyWithLlm({
      input,
      output: patched,
      bannedKeys
    });

    if (llmReply) {
      patched.npcReply = llmReply;
    } else if (needFailTaunt) {
      patched.npcReply = localFailFallback(input, bannedKeys);
    } else if (duplicate) {
      patched.npcReply = withUniqueSuffix("Keep talking, but this isn't enough.", bannedKeys);
    }
  }

  if (
    needFailTaunt &&
    !hasIntegratedGuidance(patched.npcReply, input.stage) &&
    !hasActionableGuidance(patched.npcReply)
  ) {
    patched.npcReply = appendIntegratedGuidance(patched.npcReply, stageHint);
  }

  const finalKey = normalizeReplyKey(patched.npcReply);
  if (finalKey && bannedKeys.has(finalKey)) {
    patched.npcReply = withUniqueSuffix(patched.npcReply, bannedKeys);
  }

  if (patched.revealCode && patched.code && !patched.npcReply.includes(patched.code)) {
    patched.npcReply = `${patched.npcReply} Defuse code: ${patched.code}.`;
  }

  rememberNpcReply(patched.npcReply);
  return patched;
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

  const stage = toInt(parsed.stage, input.stage, 1, FINAL_STAGE);
  const nextStage = toInt(parsed.nextStage, stage, 1, FINAL_STAGE);
  const passStage = Boolean(parsed.passStage);
  const failureReason =
    typeof parsed.failureReason === "string" && parsed.failureReason.trim().length > 0
      ? parsed.failureReason.trim().slice(0, 140)
      : null;

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
    npcMood,
    stage,
    nextStage,
    passStage,
    failureReason
  };
}

function hasPattern(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function isEmotionDetected(input: EvaluateInput, target: PlayerEmotion) {
  if (input.playerEmotion !== target) return false;
  if (typeof input.emotionScore !== "number" || !Number.isFinite(input.emotionScore)) return true;
  return input.emotionScore >= 0.12;
}

function passesStageHeuristics(stage: number, input: EvaluateInput) {
  if (stage === 1) return input.transcript.trim().length > 0;
  if (stage === 2) return isEmotionDetected(input, "sad");
  if (stage === 3) return isEmotionDetected(input, "angry");
  if (stage === 4) return isEmotionDetected(input, "angry");
  return false;
}

function applyEmotionShift(
  output: EvaluateOutput,
  input: EvaluateInput,
  emotionShiftMap: Record<PlayerEmotion, number>
) {
  if (!input.playerEmotion) return;

  const baseShift = emotionShiftMap[input.playerEmotion];
  const confidence = input.emotionScore ?? 0.55;
  const weight = clamp(0.65 + confidence * 0.75, 0.65, 1.35);
  const shift = Math.round(baseShift * weight);

  if (shift === 0) return;
  output.newSuspicion = clamp(output.newSuspicion + shift, 0, 100);
}

function applyLevelOneTutorialGate(base: EvaluateOutput, input: EvaluateInput): EvaluateOutput {
  const currentStage = clamp(input.stage, 1, FINAL_STAGE);
  const output: EvaluateOutput = {
    ...base,
    stage: currentStage,
    nextStage: currentStage
  };

  const stagePass = passesStageHeuristics(currentStage, input);
  const heardEmotion = input.playerEmotion ?? "none";
  const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)];

  if (!stagePass) {
    output.passStage = false;
    output.nextStage = currentStage;
    output.shouldHangUp = false;
    output.revealCode = false;
    output.code = null;
    output.npcMood = currentStage === 1 ? "suspicious" : "hostile";
    output.newSuspicion = clamp(Math.max(output.newSuspicion, input.suspicion + (currentStage === 1 ? 2 : 6)), 0, 100);
    output.suspicionDelta = clamp(output.newSuspicion - input.suspicion, -20, 20);

    if (currentStage === 1) {
      output.failureReason = "Opening line missing";
      output.npcReply = "Speak clearly first. Then we begin.";
      return output;
    }

    if (currentStage === 2) {
      output.failureReason = `Expected sad emotion, got ${heardEmotion}`;
      output.npcReply = pick([
        "No sadness detected. Let me hear pain in your voice.",
        "Still too steady. Sound hurt, heavy, and down.",
        "I don't buy it. Make me hear sadness."
      ]);
      return output;
    }

    if (currentStage === 3) {
      output.failureReason = `Expected angry emotion, got ${heardEmotion}`;
      output.npcReply = pick([
        "Weak. I need anger, not restraint. Raise your voice.",
        "Not angry enough. I want rage in your tone.",
        "Still polite. Sound angry if you want stage progress."
      ]);
      return output;
    }

    output.failureReason = `Expected angry emotion, got ${heardEmotion}`;
    output.npcReply = pick([
      "Close, but I need more rage. Get angrier and hit again.",
      "Not enough pressure. Give me anger again, harder.",
      "Still holding back. I need raw anger one more time."
    ]);
    return output;
  }

  output.passStage = true;
  output.failureReason = null;
  output.shouldHangUp = false;

  if (currentStage === 1) {
    output.nextStage = 2;
    output.revealCode = false;
    output.code = null;
    output.npcMood = "hostile";
    output.npcReply = pick([
      "Convince me? You're flat. I need sadness. Let your voice sink.",
      "Normal tone won't cut it. Sound sad if you want progress.",
      "Too steady. Give me sadness, not confidence."
    ]);
  } else if (currentStage === 2) {
    output.nextStage = 3;
    output.revealCode = false;
    output.code = null;
    output.npcMood = "hostile";
    output.npcReply = pick([
      "There it is, sadness. Now I want anger. Say it furious.",
      "Good, you sound sad. Flip it to anger right now.",
      "Sadness confirmed. Next step: get angry and mean it."
    ]);
  } else if (currentStage === 3) {
    output.nextStage = 4;
    output.revealCode = false;
    output.code = null;
    output.npcMood = "hostile";
    output.npcReply = pick([
      "Better. That anger bites. Push harder and I might break.",
      "Now we're talking. Hit me with anger again.",
      "Good rage. One more angry push and I crack."
    ]);
  } else {
    output.nextStage = FINAL_STAGE;
    output.revealCode = true;
    output.code = output.code ?? generateCode();
    output.npcMood = "hostile";
    output.npcReply = pick([
      `Stop! You broke me. Defuse code: ${output.code}.`,
      `Fine, enough rage. Defuse code: ${output.code}.`,
      `Alright, I fold. Defuse code: ${output.code}.`
    ]);
  }

  console.info("✅  [Level1 Tutorial] Stage cleared", {
    stage: currentStage,
    nextStage: output.nextStage,
    detectedEmotion: input.playerEmotion,
    emotionScore: input.emotionScore
  });

  output.suspicionDelta = clamp(output.newSuspicion - input.suspicion, -20, 20);
  return output;
}

function applyLevelRules(base: EvaluateOutput, input: EvaluateInput): EvaluateOutput {
  const rules = LEVEL_RULES[input.level];
  const playerCorpus = [
    input.transcript,
    ...input.history.filter((line) => line.role === "player").map((line) => line.content)
  ]
    .join(" ")
    .toLowerCase();

  const threatIntent = hasPattern(playerCorpus, THREAT_PATTERNS);
  const petIntent = hasPattern(playerCorpus, PET_PATTERNS);
  const emotion = input.playerEmotion;

  const output: EvaluateOutput = { ...base };
  applyEmotionShift(output, input, rules.emotionShift);

  if (input.level === 1) {
    return applyLevelOneTutorialGate(output, input);
  }

  if (input.level === 2) {
    const isAggressive = emotion === "angry" || emotion === "disgust";
    const isTrustBuilding = emotion === "happy" || emotion === "sad";
    const TRUST_THRESHOLD = 25;

    // Stage 1: Build Trust
    if (input.stage === 1) {
      if (output.newSuspicion <= TRUST_THRESHOLD) {
        output.passStage = true;
        output.nextStage = 2;
        output.npcMood = "calm";
        output.npcReply = "Purr... you seem nice. I like being petted, you know.";
      } else {
        output.passStage = false;
        output.nextStage = 1;
        output.revealCode = false;
        output.code = null;

        if (isAggressive || threatIntent) {
          output.npcMood = "hostile";
          output.newSuspicion = clamp(output.newSuspicion + 15, 0, 100);
          output.npcReply = "Hiss! You're mean! I'm keeping your Suica!";
          output.failureReason = "Player was aggressive. Needs to show happy or sad emotion.";
        } else if (isTrustBuilding) {
          output.npcMood = "suspicious";
          output.npcReply = emotion === "sad"
            ? "Aww, don't be sad. But I'm not sure about you yet..."
            : "You seem happy, but I still don't fully trust you.";
          output.failureReason = "Trust building in progress. Suspicion not low enough yet.";
        } else {
          output.npcMood = "suspicious";
          output.npcReply = "Miao. I'm keeping this shiny Suica card. Try being nicer to me.";
          output.failureReason = "Player needs to show happy or sad emotion to lower suspicion.";
        }
      }
    }
    // Stage 2: Earn trust + Petting
    else if (input.stage === 2) {
      if (petIntent) {
        if (isAggressive) {
          output.passStage = false;
          output.nextStage = 2;
          output.npcMood = "hostile";
          output.newSuspicion = clamp(output.newSuspicion + 10, 0, 100);
          output.npcReply = "Hiss! I don't want angry pets!";
          output.failureReason = "Player tried to pet but was angry/aggressive.";
        } else {
          output.passStage = true;
          output.nextStage = 3;
          output.revealCode = true;
          output.code = generateCode(); // Suica "Code" returned
          output.npcMood = "calm";
          output.npcReply = `Purrs happily. Okay, here is your Suica card back: ${output.code}. Go catch your train!`;
        }
      } else {
        output.passStage = false;
        output.nextStage = 2;
        output.revealCode = false;
        output.code = null;
        output.npcMood = "calm";
        output.npcReply = "Miao. I told you I like being petted...";
        output.failureReason = "Player must explicitly express intent to pet/cuddle.";
      }
    }
    // Stage 3 (Final)
    else {
      output.passStage = true;
      output.nextStage = 3;
      output.revealCode = true;
      output.code = output.code ?? generateCode();
      output.npcMood = "calm";
      output.npcReply = `Have a safe trip! Suica card code: ${output.code}.`;
    }

    output.shouldHangUp = output.newSuspicion >= rules.forcedHangupSuspicion;
    if (output.shouldHangUp && !output.revealCode) {
      output.npcReply = "Hiss! I'm leaving. Goodbye Suica!";
    }
  }

  if (output.newSuspicion >= rules.forcedHangupSuspicion && !output.revealCode) {
    output.shouldHangUp = true;
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
  const stageRaw = Number(body.stage);
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
    timeRemaining: clamp(Math.round(timeRemaining), 0, MAX_TIME_SECONDS),
    suspicion: clamp(Math.round(suspicion), 0, 100),
    history: history.slice(-12),
    round: clamp(Math.round(round), 1, 25),
    stage: clamp(
      Math.min(Math.round(Number.isFinite(stageRaw) ? stageRaw : 1), clamp(Math.round(round), 1, 25)),
      1,
      FINAL_STAGE
    ),
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
          "Invalid payload. Check transcript/timeRemaining/suspicion/history/round/stage/level/playerEmotion."
      },
      { status: 400 }
    );
  }

  console.info("🎭  [Evaluate] Incoming turn", {
    level: input.level,
    round: input.round,
    stage: input.stage,
    timeRemaining: input.timeRemaining,
    suspicion: input.suspicion,
    playerEmotion: input.playerEmotion,
    emotionScore: input.emotionScore
  });

  const levelRules = LEVEL_RULES[input.level];
  const context = levelRules.context;

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
        stage: input.stage,
        stageObjective:
          input.level === 1
            ? LEVEL1_STAGE_OBJECTIVES[input.stage] ?? LEVEL1_STAGE_OBJECTIVES[FINAL_STAGE]
            : null,
        stageHint:
          input.level === 1 ? LEVEL1_STAGE_HINTS[input.stage] ?? LEVEL1_STAGE_HINTS[FINAL_STAGE] : null,
        level1Flow:
          input.level === 1
            ? {
              stage1: "Tutorial opener: player answers naturally after the code challenge.",
              stage2: "NPC demands sadness. Progress requires detected sad emotion.",
              stage3: "NPC taunts the player. Progress requires detected angry emotion.",
              stage4: "NPC starts to break. Another detected angry emotion reveals the code."
            }
            : null,
        minStagesRequired: input.level === 1 ? FINAL_STAGE : null,
        playerEmotion: input.playerEmotion,
        emotionScore: input.emotionScore,
        emotionGuidance: context.emotionGuidance
      })
    }
  ];

  let modelRaw: string;
  try {
    modelRaw = await createMistralChatCompletion(messages, MODEL);
  } catch (error) {
    console.error("🚨  [Evaluate] Mistral call failed", error);
    const fallback = safeFallback(input);
    const polishedFallback = await enforceReplyPolicies(fallback, input).catch(() => fallback);
    return NextResponse.json(polishedFallback, { status: 200 });
  }

  const parsed = parseModelJson(modelRaw);
  if (!parsed) {
    console.warn("⚠️  [Evaluate] JSON parse fallback triggered");
    const fallback = safeFallback(input);
    const polishedFallback = await enforceReplyPolicies(fallback, input).catch(() => fallback);
    return NextResponse.json(polishedFallback, { status: 200 });
  }

  const normalized = normalizeOutput(parsed, input);
  const levelApplied = applyLevelRules(normalized, input);

  try {
    const polished = await enforceReplyPolicies(levelApplied, input);
    return NextResponse.json(polished, { status: 200 });
  } catch (error) {
    console.warn("⚠️  [Evaluate] Reply policy enforcement fallback", error);
    return NextResponse.json(levelApplied, { status: 200 });
  }
}
