const DEFAULT_LOCAL_EMOTION_URL = "http://127.0.0.1:5050";
const DEFAULT_LOCAL_EMOTION_MODEL = "3loi/SER-Odyssey-Baseline-WavLM-Categorical";
const LOCAL_EMOTION_URL = (process.env.EMOTION_LOCAL_URL ?? DEFAULT_LOCAL_EMOTION_URL).trim();

const EMOTIONS = ["angry", "disgust", "fear", "happy", "neutral", "sad", "surprise"] as const;

export type PlayerEmotion = (typeof EMOTIONS)[number];

export interface SpeechEmotionResult {
  label: PlayerEmotion;
  score: number;
  scores: Record<PlayerEmotion, number>;
  model: string;
}

interface EmotionPrediction {
  label?: unknown;
  score?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPrediction(value: unknown): value is EmotionPrediction {
  return isRecord(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeEmotionLabel(raw: string): PlayerEmotion | null {
  const value = raw.trim().toLowerCase();
  if ((EMOTIONS as readonly string[]).includes(value)) return value as PlayerEmotion;

  if (value === "ang" || value === "anger") return "angry";
  if (value === "hap" || value === "happiness" || value === "joy" || value === "joyful") return "happy";
  if (value === "neu") return "neutral";
  if (value === "sadness") return "sad";
  if (value === "sur" || value === "surprised") return "surprise";
  if (value === "fea" || value === "fearful") return "fear";
  if (value === "dis" || value === "disgusted") return "disgust";

  return null;
}

function parsePredictions(payload: unknown): EmotionPrediction[] {
  if (Array.isArray(payload)) {
    if (payload.length > 0 && Array.isArray(payload[0])) {
      return (payload[0] as unknown[]).filter(isPrediction);
    }
    return payload.filter(isPrediction);
  }

  if (isRecord(payload) && Array.isArray(payload.predictions)) {
    return payload.predictions.filter(isPrediction);
  }

  if (isRecord(payload) && typeof payload.error === "string") {
    throw new Error(`Local emotion service error: ${payload.error.slice(0, 300)}`);
  }

  return [];
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

function buildResult(predictions: EmotionPrediction[]): SpeechEmotionResult {
  const scores = buildEmptyScoreMap();

  for (const prediction of predictions) {
    if (!isRecord(prediction)) continue;

    const rawLabel = typeof prediction.label === "string" ? prediction.label : "";
    const label = normalizeEmotionLabel(rawLabel);
    if (!label) continue;

    const numericScore = Number(prediction.score);
    if (!Number.isFinite(numericScore)) continue;

    scores[label] = Math.max(scores[label], clamp(numericScore, 0, 1));
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [label, score] = sorted[0] ?? ["neutral", 0];

  if (score <= 0) {
    throw new Error("Local emotion service returned no valid emotion scores.");
  }

  return {
    label: label as PlayerEmotion,
    score: clamp(score, 0, 1),
    scores,
    model: process.env.EMOTION_MODEL ?? DEFAULT_LOCAL_EMOTION_MODEL
  };
}

export async function classifySpeechEmotion(file: File): Promise<SpeechEmotionResult> {
  const baseUrl = LOCAL_EMOTION_URL.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("EMOTION_LOCAL_URL is missing.");
  }

  const formData = new FormData();
  formData.append("file", file, file.name || "audio.webm");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/classify`, {
      method: "POST",
      body: formData,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Local emotion service request timed out.");
    }
    throw new Error(`Unable to reach local emotion service at ${baseUrl}.`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "Unknown error");
    throw new Error(`Local emotion service error (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  const predictions = parsePredictions(payload);

  if (predictions.length === 0) {
    throw new Error("Local emotion service returned no predictions.");
  }

  return buildResult(predictions);
}
