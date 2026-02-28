const ELEVENLABS_TTS_BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech";

export const DEFAULT_ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5";
export const DEFAULT_ELEVENLABS_VOICE =
  process.env.ELEVENLABS_VOICE_ID ?? "zYcjlYFOd3taleS0gkk3";
export const DEFAULT_ELEVENLABS_VOICE_LEVEL_2 =
  process.env.ELEVENLABS_VOICE_ID_LEVEL_2 ?? "ocZQ262SsZb9RIxcQBOj";
export const DEFAULT_ELEVENLABS_OUTPUT_FORMAT =
  process.env.ELEVENLABS_OUTPUT_FORMAT ?? "mp3_22050_32";
export const DEFAULT_ELEVENLABS_STREAMING_LATENCY =
  process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY ?? "4";

interface ElevenLabsTtsParams {
  text: string;
  modelId?: string;
  voiceId?: string;
  voiceSettings?: ElevenLabsVoiceSettings;
}

interface ElevenLabsTtsResult {
  audioBuffer: ArrayBuffer;
  contentType: string;
}

interface ElevenLabsStreamResult {
  stream: ReadableStream<Uint8Array> | null;
  contentType: string;
}

export interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
}

function getApiKey() {
  return process.env.ELEVENLABS_API_KEY ?? process.env.ELEVENLABS ?? "";
}

async function requestElevenLabsTts({
  text,
  modelId,
  voiceId,
  streamMode,
  voiceSettings
}: {
  text: string;
  modelId: string;
  voiceId: string;
  streamMode: boolean;
  voiceSettings?: ElevenLabsVoiceSettings;
}): Promise<Response> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY (or ELEVENLABS) is missing.");
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new Error("Text is empty.");
  }

  const endpoint = streamMode ? `${voiceId}/stream` : voiceId;
  const query = new URLSearchParams({
    output_format: DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
    optimize_streaming_latency: DEFAULT_ELEVENLABS_STREAMING_LATENCY
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let response: Response;
  try {
    response = await fetch(`${ELEVENLABS_TTS_BASE_URL}/${endpoint}?${query.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
        "xi-api-key": apiKey
      },
      body: JSON.stringify({
        text: trimmedText.slice(0, 650),
        model_id: modelId,
        voice_settings: voiceSettings ?? {
          stability: 0.35,
          similarity_boost: 0.75,
          style: 0.2,
          use_speaker_boost: true
        }
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("ElevenLabs TTS request timed out.");
    }
    throw new Error("Unable to reach ElevenLabs TTS API.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "Unknown error");
    throw new Error(`ElevenLabs TTS API error (${response.status}): ${details.slice(0, 300)}`);
  }

  return response;
}

export async function synthesizeWithElevenLabs({
  text,
  modelId = DEFAULT_ELEVENLABS_MODEL,
  voiceId = DEFAULT_ELEVENLABS_VOICE,
  voiceSettings
}: ElevenLabsTtsParams): Promise<ElevenLabsTtsResult> {
  const response = await requestElevenLabsTts({
    text,
    modelId,
    voiceId: voiceId ?? DEFAULT_ELEVENLABS_VOICE,
    streamMode: false,
    voiceSettings
  });

  return {
    audioBuffer: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") || "audio/mpeg"
  };
}

export async function synthesizeWithElevenLabsStream({
  text,
  modelId = DEFAULT_ELEVENLABS_MODEL,
  voiceId = DEFAULT_ELEVENLABS_VOICE,
  voiceSettings
}: ElevenLabsTtsParams): Promise<ElevenLabsStreamResult> {
  const response = await requestElevenLabsTts({
    text,
    modelId,
    voiceId: voiceId ?? DEFAULT_ELEVENLABS_VOICE,
    streamMode: true,
    voiceSettings
  });

  return {
    stream: response.body,
    contentType: response.headers.get("content-type") || "audio/mpeg"
  };
}
