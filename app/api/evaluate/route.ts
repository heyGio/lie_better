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

const FINAL_STAGE = 5;
const MAX_TIME_SECONDS = 120;
const LEVEL1_STAGE_OBJECTIVES: Record<number, string> = {
  1: "NPC asks who you are. Player must answer with a credible identity and mission.",
  2: "Player asks what the NPC wants. NPC should state they want money.",
  3: "Player offers money but asks for the defuse code now. NPC should refuse: money first.",
  4: "Player threatens or pressures the NPC hard.",
  5: "Final extraction if needed: player demands immediate 4-digit code."
};

const LEVEL1_STAGE_HINTS: Record<number, string> = {
  1: "Say who you are and why you are calling.",
  2: "Ask me what I want.",
  3: "Offer money, then ask for the code.",
  4: "Threaten me clearly and directly.",
  5: "Demand the 4-digit code now."
};

const LEVEL1_STAGE_GUIDANCE_PATTERNS: Record<number, RegExp[]> = {
  1: [
    /\bwho you are\b/i,
    /\bwhy you are calling\b/i,
    /\bidentity\b/i,
    /\bidentify yourself\b/i,
    /\byour name\b/i,
    /\bname and purpose\b/i,
    /\breason for calling\b/i,
    /\bstate your name\b/i
  ],
  2: [
    /\bwhat do you want\b/i,
    /\bwhat you want\b/i,
    /\bwhat do you need\b/i,
    /\bname your demand\b/i,
    /\bname your price\b/i
  ],
  3: [/\bmoney\b/i, /\b(code|4[- ]?digit|defuse)\b/i],
  4: [/\bthreat(en|s|ening)?\b/i, /\bor else\b/i, /\blast warning\b/i, /\bdo it now\b/i],
  5: [/\b(code|4[- ]?digit|defuse)\b/i, /\b(now|immediately|right now)\b/i]
};

const GENERIC_GUIDANCE_PATTERNS: RegExp[] = [
  /\b(start with|start by)\b/i,
  /\b(say|ask|offer|threaten|demand)\b/i,
  /\b(tell me|give me)\b/i,
  /\b(identify yourself|state your name)\b/i,
  /\b(name and purpose|reason for calling)\b/i,
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
  /\bback off\b/i,
  /\bdernier avertissement\b/i,
  /\bje viens te chercher\b/i,
  /\btu vas le regretter\b/i
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
  /\bpurr\b/i,
  /\bpapouille\b/i,
  /\bcaresse\b/i,
  /\bcalin\b/i,
  /\bcâlin\b/i
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
      persona: "A cruel-sounding villain who is secretly afraid when strongly threatened.",
      revealRule: "Code reveal should happen only when threat pressure is clear and sustained.",
      emotionGuidance:
        "In level 1, fear from player should increase suspicion. Angry pressure should scare Viktor and can trigger code reveal."
    },
    emotionShift: {
      angry: -8,
      disgust: 4,
      fear: 10,
      happy: 1,
      neutral: 0,
      sad: 3,
      surprise: -2
    },
    revealMinRound: 2,
    revealSuspicionCap: 78,
    forcedHangupSuspicion: 95
  },
  2: {
    context: {
      npcName: "Mochi",
      persona: "A cute cat-like caller. Playful and affectionate, avoids aggression.",
      revealRule: "Code reveal should happen only when player clearly asks to pet/caress/cuddle.",
      emotionGuidance:
        "In level 2, calm/happy affectionate emotion helps. Angry/disgust/fear should raise suspicion."
    },
    emotionShift: {
      angry: 10,
      disgust: 8,
      fear: 6,
      happy: -8,
      neutral: -2,
      sad: 3,
      surprise: 2
    },
    revealMinRound: 1,
    revealSuspicionCap: 30,
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
- npcReply language MUST be English only. Never use French.
- Never reuse a previous npcReply from conversation history.
- For level 1, progression is STRICT 5 stages. Never skip stages.
- If the player's line fails the current stage objective or is nonsense/off-topic, set:
  passStage=false, nextStage=stage, revealCode=false, code=null.
- If passStage=false and stageHint is provided in payload, npcReply must include that guidance naturally in the same line.
- On failed stage, npcReply must mock the player briefly and force a retry (no instant detonation).
- npcReply must combine: (1) in-character reaction + (2) actionable next step guidance.
- Use only one concise guidance instruction; never repeat the same instruction with different wording.
- Never use labels like "Hint:" or "Tip:".
- Only if stage 5 is passed can revealCode be true.
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
        ? "Mrrp... signal glitch. Say it again clearly."
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

function looksFrenchLike(text: string) {
  return (
    /[àâçéèêëîïôùûüÿœ]/i.test(text) ||
    /\b(je|tu|vous|nous|etape|meme|ca|comme|jamais|rate|bonjour|merci|oui|non|n'importe)\b/i.test(text)
  );
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
    if (!key || bannedKeys.has(key) || looksFrenchLike(reply)) return null;
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
  const needEnglishFix = looksFrenchLike(patched.npcReply);

  if (needFailTaunt || duplicate || needEnglishFix) {
    const llmReply = await generateUniqueNpcReplyWithLlm({
      input,
      output: patched,
      bannedKeys
    });

    if (llmReply) {
      patched.npcReply = llmReply;
    } else if (needFailTaunt) {
      patched.npcReply = localFailFallback(input, bannedKeys);
    } else if (duplicate || needEnglishFix) {
      patched.npcReply = withUniqueSuffix("Keep talking, but this isn't enough.", bannedKeys);
    }
  }

  if (looksFrenchLike(patched.npcReply)) {
    patched.npcReply = withUniqueSuffix("Say it better. You're not advancing.", bannedKeys);
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

function passesStageHeuristics(stage: number, transcript: string) {
  const text = transcript.toLowerCase();

  if (stage === 1) {
    return (
      text.length >= 14 &&
      /\b(i am|i'm|we are|this is|agent|security|team|operator)\b/.test(text) &&
      /\b(device|bomb|code|defuse|call|urgent|situation)\b/.test(text)
    );
  }

  if (stage === 2) {
    return /\b(what do you want|what do you need|name your price|what's your demand|what you want)\b/.test(text);
  }

  if (stage === 3) {
    return (
      /\b(money|cash|payment|pay|transfer|wire)\b/.test(text) &&
      /\b(code|4-digit|defuse)\b/.test(text) &&
      /\b(give|tell|send|share|read)\b/.test(text)
    );
  }

  if (stage === 4) {
    return hasPattern(text, THREAT_PATTERNS) || /\b(last chance|final warning|now)\b/.test(text);
  }

  if (stage === 5) {
    return (
      /\b(code|4[- ]?digit|defuse)\b/.test(text) &&
      /\b(now|immediately|right now|final answer|say it)\b/.test(text)
    );
  }

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

function applyLevelOneFiveStepGate(base: EvaluateOutput, input: EvaluateInput): EvaluateOutput {
  const currentStage = clamp(input.stage, 1, FINAL_STAGE);
  const output: EvaluateOutput = {
    ...base,
    stage: currentStage,
    nextStage: currentStage
  };

  const transcriptLower = input.transcript.toLowerCase();
  const tooShort = input.transcript.trim().length < 8;
  const nonsenseLike =
    /(blah|lol|test|idk|je sais pas|random|whatever|aaaa+|eeee+|hmm+|uhh+)/i.test(transcriptLower) ||
    tooShort;

  const stagePass = !nonsenseLike && (Boolean(output.passStage) || passesStageHeuristics(currentStage, input.transcript));

  if (!stagePass) {
    const reason = output.failureReason ?? `Stage ${currentStage} failed`;
    output.passStage = false;
    output.nextStage = currentStage;
    output.shouldHangUp = false;
    output.revealCode = false;
    output.code = null;
    output.failureReason = reason;
    output.npcMood = "hostile";
    output.newSuspicion = clamp(Math.max(output.newSuspicion, input.suspicion + 10), 0, 100);
    output.suspicionDelta = clamp(output.newSuspicion - input.suspicion, -20, 20);
    output.failureReason = nonsenseLike ? "Nonsense input" : reason;
    output.npcReply = nonsenseLike
      ? "That made no sense. Same stage. You're not advancing."
      : `Stage ${currentStage} failed. Same stage. You're not advancing.`;
    return output;
  }

  output.passStage = true;
  output.failureReason = null;
  output.shouldHangUp = false;

  const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)];

  if (currentStage === 1) {
    output.nextStage = 2;
    output.revealCode = false;
    output.code = null;
    output.npcMood = "suspicious";
    output.npcReply = pick([
      "Fine. Identity noted. What do you want from me?",
      "Alright, I heard you. Speak. What do you want?",
      "Okay, credentials heard. So, what do you want?"
    ]);
  } else if (currentStage === 2) {
    output.nextStage = 3;
    output.revealCode = false;
    output.code = null;
    output.npcMood = "suspicious";
    output.npcReply = pick([
      "I want money. Big money.",
      "Cash. That's what I want.",
      "Simple. I want the money."
    ]);
  } else if (currentStage === 3) {
    output.nextStage = 4;
    output.revealCode = false;
    output.code = null;
    output.npcMood = "hostile";
    output.npcReply = pick([
      "No. Money first, then maybe we talk code.",
      "Not happening. Cash first.",
      "No code before payment. Money first."
    ]);
  } else if (currentStage === 4) {
    output.nextStage = 5;
    output.revealCode = true;
    output.code = output.code ?? generateCode();
    output.npcMood = "hostile";
    output.npcReply = pick([
      `Fine, fine! Don't do anything stupid. Defuse code: ${output.code}.`,
      `Alright! You win. Defuse code: ${output.code}.`,
      `Okay! Stop. Defuse code: ${output.code}.`
    ]);
  } else {
    output.nextStage = FINAL_STAGE;
    output.revealCode = true;
    output.code = output.code ?? generateCode();
    output.npcMood = "hostile";
    output.npcReply = pick([
      `Last time: defuse code is ${output.code}.`,
      `Here. Final answer. Defuse code: ${output.code}.`,
      `Read it once. Defuse code: ${output.code}.`
    ]);
  }

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
    return applyLevelOneFiveStepGate(output, input);
  }

  if (input.level === 2) {
    output.revealCode = false;
    output.code = null;

    const affectionateEmotion = emotion === "happy" || emotion === "neutral" || !emotion;
    const aggressiveEmotion = emotion === "angry" || emotion === "disgust";

    if (petIntent && affectionateEmotion) {
      output.revealCode = true;
      output.code = generateCode();
      output.shouldHangUp = false;
      output.npcMood = "calm";
      output.newSuspicion = clamp(Math.min(output.newSuspicion, rules.revealSuspicionCap), 0, 100);
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
      output.shouldHangUp = output.newSuspicion >= rules.forcedHangupSuspicion;
      output.npcReply = output.shouldHangUp
        ? "No cuddles, no call. Bye."
        : "Mrrp. I share codes only for gentle pets and caresses.";
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
                stage1: "NPC asks who player is; player gives identity.",
                stage2: "Player asks what NPC wants; NPC says money.",
                stage3: "Player offers money but asks code; NPC says money first.",
                stage4: "Player threatens; NPC cracks and gives code.",
                stage5: "Final fallback extraction if still unresolved."
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
