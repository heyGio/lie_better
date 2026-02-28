export const DEFAULT_MISTRAL_MODEL = process.env.MISTRAL_MODEL ?? "mistral-large-latest";
export const DEFAULT_MISTRAL_TRANSCRIPTION_MODEL =
  process.env.MISTRAL_TRANSCRIPTION_MODEL ?? "voxtral-mini-latest";

const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
const MISTRAL_TRANSCRIPTION_API_URL = "https://api.mistral.ai/v1/audio/transcriptions";

export interface MistralChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface MistralChoice {
  message?: {
    content?: unknown;
  };
}

interface MistralResponse {
  choices?: MistralChoice[];
}

interface MistralTranscriptionResponse {
  text?: string;
  language?: string;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) {
        return String((item as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("")
    .trim();
}

export async function createMistralChatCompletion(
  messages: MistralChatMessage[],
  model: string = DEFAULT_MISTRAL_MODEL
): Promise<string> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is missing.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let response: Response;
  try {
    response = await fetch(MISTRAL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.25,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Mistral request timed out.");
    }
    throw new Error("Unable to reach Mistral API.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "Unknown error");
    throw new Error(`Mistral API error (${response.status}): ${details.slice(0, 300)}`);
  }

  const data = (await response.json()) as MistralResponse;
  const rawContent = data.choices?.[0]?.message?.content;
  const content = flattenContent(rawContent);

  if (!content) {
    throw new Error("Mistral returned an empty response.");
  }

  return content;
}

interface CreateMistralTranscriptionParams {
  file: File;
  language?: string;
  model?: string;
}

interface CreateMistralTranscriptionResult {
  text: string;
  language: string | null;
}

export async function createMistralTranscription({
  file,
  language,
  model = DEFAULT_MISTRAL_TRANSCRIPTION_MODEL
}: CreateMistralTranscriptionParams): Promise<CreateMistralTranscriptionResult> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is missing.");
  }

  const formData = new FormData();
  formData.append("model", model);
  formData.append("file", file, file.name || "speech.webm");
  if (language) {
    formData.append("language", language);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  let response: Response;
  try {
    response = await fetch(MISTRAL_TRANSCRIPTION_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Mistral transcription request timed out.");
    }
    throw new Error("Unable to reach Mistral transcription API.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "Unknown error");
    throw new Error(`Mistral transcription API error (${response.status}): ${details.slice(0, 300)}`);
  }

  const data = (await response.json()) as MistralTranscriptionResponse;
  const text = typeof data.text === "string" ? data.text.trim() : "";

  if (!text) {
    throw new Error("Mistral transcription returned empty text.");
  }

  return {
    text,
    language: typeof data.language === "string" ? data.language : null
  };
}
