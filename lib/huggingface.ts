const DEFAULT_HF_EMOTION_MODEL =
  process.env.HF_EMOTION_MODEL ?? "r-f/wav2vec-english-speech-emotion-recognition";

const DEFAULT_HF_EMOTION_URL =
  process.env.HF_EMOTION_API_URL ??
  `https://api-inference.huggingface.co/models/${DEFAULT_HF_EMOTION_MODEL}`;

const EMOTIONS = ["angry", "disgust", "fear", "happy", "neutral", "sad", "surprise"] as const;

export type PlayerEmotion = (typeof EMOTIONS)[number];

export interface SpeechEmotionResult {
  label: PlayerEmotion;
  score: number;
  scores: Record<PlayerEmotion, number>;
  model: string;
}

interface HfEmotionPrediction {
  label?: unknown;
  score?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPrediction(value: unknown): value is HfEmotionPrediction {
  return isRecord(value);
}

function getApiToken() {
  return (
    process.env.HUGGINGFACE_API_TOKEN ??
    process.env.HF_TOKEN ??
    process.env.HUGGINGFACE_TOKEN ??
    ""
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeEmotionLabel(raw: string): PlayerEmotion | null {
  const value = raw.trim().toLowerCase();
  if ((EMOTIONS as readonly string[]).includes(value)) return value as PlayerEmotion;

  if (value === "anger") return "angry";
  if (value === "surprised") return "surprise";
  return null;
}

function parsePredictions(payload: unknown): HfEmotionPrediction[] {
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
    throw new Error(`Hugging Face error: ${payload.error.slice(0, 300)}`);
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

export async function classifySpeechEmotion(file: File): Promise<SpeechEmotionResult> {
  const token = getApiToken();
  if (!token) {
    throw new Error("HUGGINGFACE_API_TOKEN (or HF_TOKEN) is missing.");
  }

  const audioBuffer = await file.arrayBuffer();
  if (!audioBuffer.byteLength) {
    throw new Error("Audio buffer is empty.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let response: Response;
  try {
    response = await fetch(DEFAULT_HF_EMOTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": file.type || "application/octet-stream",
        "x-wait-for-model": "true"
      },
      body: audioBuffer,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Hugging Face emotion request timed out.");
    }
    throw new Error("Unable to reach Hugging Face emotion API.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "Unknown error");
    throw new Error(`Hugging Face API error (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  const predictions = parsePredictions(payload);

  if (predictions.length === 0) {
    throw new Error("Hugging Face returned no emotion predictions.");
  }

  const scores = buildEmptyScoreMap();
  for (const prediction of predictions) {
    if (!isRecord(prediction)) continue;
    const labelRaw = typeof prediction.label === "string" ? prediction.label : "";
    const normalizedLabel = normalizeEmotionLabel(labelRaw);
    if (!normalizedLabel) continue;

    const numericScore = Number(prediction.score);
    if (!Number.isFinite(numericScore)) continue;
    scores[normalizedLabel] = clamp(numericScore, 0, 1);
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [label, score] = sorted[0] ?? ["neutral", 0];

  if (score <= 0) {
    throw new Error("Hugging Face emotion scores are empty.");
  }

  return {
    label: label as PlayerEmotion,
    score: clamp(score, 0, 1),
    scores,
    model: DEFAULT_HF_EMOTION_MODEL
  };
}
