import { spawn } from "node:child_process";
import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
  createUserContent
} from "@google/genai";

const DEFAULT_GEMINI_EMOTION_MODEL = "gemini-2.5-flash";
const GEMINI_EMOTION_MODEL = (process.env.GEMINI_EMOTION_MODEL ?? DEFAULT_GEMINI_EMOTION_MODEL).trim();
const GEMINI_TIMEOUT_MS = 35_000;
const FFMPEG_TIMEOUT_MS = 25_000;
const WAV_SAMPLE_RATE = 16_000;
const WAV_MIME_TYPE = "audio/wav";

const EMOTIONS = ["angry", "disgust", "fear", "happy", "neutral", "sad", "surprise"] as const;

export type PlayerEmotion = (typeof EMOTIONS)[number];

export interface SpeechEmotionResult {
  label: PlayerEmotion;
  score: number;
  scores: Record<PlayerEmotion, number>;
  model: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEmotionLabel(raw: string): PlayerEmotion | null {
  const value = raw.trim().toLowerCase();
  if ((EMOTIONS as readonly string[]).includes(value)) return value as PlayerEmotion;

  if (value === "anger") return "angry";
  if (value === "fearful") return "fear";
  if (value === "happiness" || value === "joy") return "happy";
  if (value === "sadness") return "sad";
  if (value === "surprised") return "surprise";

  return null;
}

function buildEmptyScoreMap() {
  return {
    angry: 0,
    disgust: 0,
    fear: 0,
    happy: 0,
    neutral: 0,
    sad: 0,
    surprise: 0
  } satisfies Record<PlayerEmotion, number>;
}

function getApiKey() {
  return (
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    ""
  ).trim();
}

function normalizeModelName(model: string) {
  const trimmed = model.trim();
  if (!trimmed) return DEFAULT_GEMINI_EMOTION_MODEL;
  return trimmed.replace(/^models\//, "");
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());

  const objectLike = trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (objectLike) candidates.push(objectLike.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function parseGeminiEmotion(rawText: string): Omit<SpeechEmotionResult, "model"> {
  const fallbackText = rawText.trim().toLowerCase();
  const payload = parseJsonObject(rawText);
  const scores = buildEmptyScoreMap();

  let label: PlayerEmotion | null = null;
  let score: number | null = null;

  if (payload) {
    const labelRaw =
      typeof payload.emotion === "string"
        ? payload.emotion
        : typeof payload.label === "string"
          ? payload.label
          : typeof payload.playerEmotion === "string"
            ? payload.playerEmotion
            : "";

    label = normalizeEmotionLabel(labelRaw);
    score =
      toNumber(payload.confidence) ??
      toNumber(payload.score) ??
      toNumber(payload.emotionScore) ??
      null;

    if (isRecord(payload.scores)) {
      for (const emotion of EMOTIONS) {
        const numeric = toNumber(payload.scores[emotion]);
        if (numeric === null) continue;
        scores[emotion] = clamp(numeric, 0, 1);
      }
    }
  }

  if (!label) {
    for (const emotion of EMOTIONS) {
      if (new RegExp(`\\b${emotion}\\b`, "i").test(fallbackText)) {
        label = emotion;
        break;
      }
    }
  }

  if (!label) {
    if (/\banger\b/i.test(fallbackText)) label = "angry";
    else if (/\bfearful\b/i.test(fallbackText)) label = "fear";
    else if (/\bhappiness\b|\bjoy\b/i.test(fallbackText)) label = "happy";
    else if (/\bsadness\b/i.test(fallbackText)) label = "sad";
    else if (/\bsurprised\b/i.test(fallbackText)) label = "surprise";
  }

  if (!label) {
    const sortedScores = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [candidate, candidateScore] = sortedScores[0] ?? ["neutral", 0];
    if (candidateScore > 0) {
      label = candidate as PlayerEmotion;
      score = candidateScore;
    }
  }

  if (!label) {
    throw new Error(`Gemini returned no valid emotion label. Raw: ${rawText.slice(0, 220)}`);
  }

  const normalizedScore = clamp(score ?? scores[label] ?? 0.55, 0, 1);
  if (scores[label] <= 0) {
    scores[label] = normalizedScore;
  }

  return {
    label,
    score: normalizedScore,
    scores
  };
}

function extractTextFromGenerateResponse(response: unknown): string {
  if (!isRecord(response)) return "";

  if (typeof response.text === "string" && response.text.trim()) {
    return response.text.trim();
  }

  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const partsText: string[] = [];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const content = candidate.content;
    if (!isRecord(content) || !Array.isArray(content.parts)) continue;

    for (const part of content.parts) {
      if (!isRecord(part)) continue;
      if (typeof part.text === "string" && part.text.trim()) {
        partsText.push(part.text.trim());
      }
    }
  }

  return partsText.join("\n").trim();
}

async function convertToWavS16Mono(file: File): Promise<Buffer> {
  const sourceBuffer = Buffer.from(await file.arrayBuffer());
  if (!sourceBuffer.length) {
    throw new Error("Audio buffer is empty.");
  }

  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-ac",
        "1",
        "-ar",
        String(WAV_SAMPLE_RATE),
        "-f",
        "wav",
        "-acodec",
        "pcm_s16le",
        "pipe:1"
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      handler();
    };

    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      finish(() => reject(new Error("Audio preprocessing timed out.")));
    }, FFMPEG_TIMEOUT_MS);

    ffmpeg.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    ffmpeg.on("error", (error) => {
      finish(() => {
        const details = error instanceof Error ? error.message : "Unknown ffmpeg error";
        reject(new Error(`Unable to run ffmpeg for audio preprocessing: ${details}`));
      });
    });

    ffmpeg.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          const details = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 300);
          reject(new Error(`ffmpeg audio conversion failed (${code}): ${details || "Unknown error"}`));
          return;
        }

        const wav = Buffer.concat(stdoutChunks);
        if (!wav.length) {
          reject(new Error("ffmpeg produced empty WAV output."));
          return;
        }

        resolve(wav);
      });
    });

    ffmpeg.stdin.on("error", () => {
      // Ignore stdin close races.
    });

    ffmpeg.stdin.end(sourceBuffer);
  });
}

async function classifyViaGeminiGenerateContent(wavBuffer: Buffer): Promise<Omit<SpeechEmotionResult, "model">> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is missing.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = normalizeModelName(GEMINI_EMOTION_MODEL);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await ai.models.generateContent({
      model,
      contents: createUserContent([
        createPartFromText(
          "Classify the dominant emotion from this player voice audio. Allowed labels only: angry, disgust, fear, happy, neutral, sad, surprise. Return strict JSON exactly like: {\"emotion\":\"angry\",\"confidence\":0.0,\"scores\":{\"angry\":0.0,\"disgust\":0.0,\"fear\":0.0,\"happy\":0.0,\"neutral\":0.0,\"sad\":0.0,\"surprise\":0.0}}"
        ),
        createPartFromBase64(wavBuffer.toString("base64"), WAV_MIME_TYPE)
      ]),
      config: {
        abortSignal: controller.signal,
        temperature: 0,
        maxOutputTokens: 180,
        responseMimeType: "application/json"
      }
    });

    const rawText = extractTextFromGenerateResponse(response);
    if (!rawText) {
      throw new Error("Gemini returned no parsable response content.");
    }

    return parseGeminiEmotion(rawText);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Gemini emotion request timed out.");
    }
    throw error instanceof Error ? error : new Error("Gemini emotion request failed.");
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyViaGeminiWithRetry(
  wavBuffer: Buffer,
  maxAttempts: number = 2
): Promise<Omit<SpeechEmotionResult, "model">> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await classifyViaGeminiGenerateContent(wavBuffer);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown Gemini emotion classification error.");
      const message = lastError.message.toLowerCase();
      const shouldRetry =
        message.includes("no parsable response content") ||
        message.includes("timed out") ||
        message.includes("429") ||
        message.includes("503") ||
        message.includes("resource_exhausted") ||
        message.includes("overloaded");

      if (!shouldRetry || attempt >= maxAttempts) {
        throw lastError;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw lastError ?? new Error("Gemini emotion classification failed.");
}

export async function classifySpeechEmotion(file: File): Promise<SpeechEmotionResult> {
  const wav = await convertToWavS16Mono(file);
  const parsed = await classifyViaGeminiWithRetry(wav, 2);
  const modelName = normalizeModelName(GEMINI_EMOTION_MODEL);

  return {
    ...parsed,
    model: modelName
  };
}
