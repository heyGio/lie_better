const LEGACY_HF_INFERENCE_PREFIX = "https://api-inference.huggingface.co/models/";
const ROUTER_HF_INFERENCE_PREFIX = "https://router.huggingface.co/hf-inference/models/";

const DEFAULT_HF_EMOTION_MODEL_RAW =
  process.env.HF_EMOTION_MODEL ?? "firdhokk/speech-emotion-recognition-with-openai-whisper-large-v3";
const DEFAULT_HF_EMOTION_MODEL = normalizeEmotionModelId(DEFAULT_HF_EMOTION_MODEL_RAW);

const DEFAULT_HF_EMOTION_URL =
  process.env.HF_EMOTION_API_URL ??
  `${ROUTER_HF_INFERENCE_PREFIX}${DEFAULT_HF_EMOTION_MODEL}`;

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
    process.env.HUGGING_FACE_API_TOKEN ??
    process.env.HF_TOKEN ??
    process.env.HF_API_KEY ??
    process.env.HUGGINGFACE_TOKEN ??
    process.env.HUGGING_FACE_TOKEN ??
    process.env.HUGGINGFACE ??
    ""
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeEmotionModelId(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "firdhokk/speech-emotion-recognition-with-openai-whisper-large-v3";

  if (trimmed.startsWith("https://huggingface.co/")) {
    const withoutDomain = trimmed.replace("https://huggingface.co/", "");
    const path = withoutDomain.split(/[?#]/)[0]?.replace(/^\/+|\/+$/g, "") ?? "";
    const [owner, repo] = path.split("/");
    if (owner && repo) return `${owner}/${repo}`;
  }

  if (trimmed.startsWith("http://huggingface.co/")) {
    const withoutDomain = trimmed.replace("http://huggingface.co/", "");
    const path = withoutDomain.split(/[?#]/)[0]?.replace(/^\/+|\/+$/g, "") ?? "";
    const [owner, repo] = path.split("/");
    if (owner && repo) return `${owner}/${repo}`;
  }

  return trimmed.replace(/^\/+|\/+$/g, "");
}

function normalizeEmotionApiUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return `${ROUTER_HF_INFERENCE_PREFIX}${DEFAULT_HF_EMOTION_MODEL}`;

  // Hugging Face retired api-inference.huggingface.co in favor of router.huggingface.co.
  if (trimmed.startsWith(LEGACY_HF_INFERENCE_PREFIX)) {
    const model = trimmed.slice(LEGACY_HF_INFERENCE_PREFIX.length);
    return `${ROUTER_HF_INFERENCE_PREFIX}${model || DEFAULT_HF_EMOTION_MODEL}`;
  }

  // Accept model page URL by converting it to the router inference URL.
  if (trimmed.startsWith("https://huggingface.co/") || trimmed.startsWith("http://huggingface.co/")) {
    const model = normalizeEmotionModelId(trimmed);
    return `${ROUTER_HF_INFERENCE_PREFIX}${model || DEFAULT_HF_EMOTION_MODEL}`;
  }

  return trimmed;
}

function normalizeEmotionLabel(raw: string): PlayerEmotion | null {
  const value = raw.trim().toLowerCase();
  if ((EMOTIONS as readonly string[]).includes(value)) return value as PlayerEmotion;

  if (value === "anger") return "angry";
  if (value === "fearful") return "fear";
  if (value === "happiness") return "happy";
  if (value === "sadness") return "sad";
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
  const emotionApiUrl = normalizeEmotionApiUrl(DEFAULT_HF_EMOTION_URL);

  const audioBuffer = await file.arrayBuffer();
  if (!audioBuffer.byteLength) {
    throw new Error("Audio buffer is empty.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let response: Response;
  try {
    response = await fetch(emotionApiUrl, {
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
    const compactDetails = details.slice(0, 300);

    if (
      response.status === 410 ||
      compactDetails.toLowerCase().includes("no longer supported") ||
      compactDetails.toLowerCase().includes("router.huggingface.co")
    ) {
      throw new Error(
        `Hugging Face endpoint retired. Use ${ROUTER_HF_INFERENCE_PREFIX}<model> or set HF_EMOTION_API_URL to your Inference Endpoint URL.`
      );
    }

    if (response.status === 404 && emotionApiUrl.startsWith(ROUTER_HF_INFERENCE_PREFIX)) {
      throw new Error(
        `Model '${DEFAULT_HF_EMOTION_MODEL}' was not found on Hugging Face Router providers. Deploy a dedicated Inference Endpoint for this model and set HF_EMOTION_API_URL.`
      );
    }

    if (
      compactDetails.toLowerCase().includes("not supported by any inference provider") ||
      compactDetails.toLowerCase().includes("model is not deployed by any inference provider") ||
      (compactDetails.toLowerCase().includes("task") &&
        compactDetails.toLowerCase().includes("not supported"))
    ) {
      throw new Error(
        `Model '${DEFAULT_HF_EMOTION_MODEL}' is not deployed on Hugging Face Router. Deploy a dedicated Inference Endpoint for this model and set HF_EMOTION_API_URL.`
      );
    }

    throw new Error(`Hugging Face API error (${response.status}): ${compactDetails}`);
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
