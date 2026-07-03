import { invoke } from "@tauri-apps/api/core";
import type { AgentSettings, DictationStyle } from "./useAgent";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OLLAMA_CLOUD_API_BASE_URL = "https://ollama.com/api";
const DICTATION_MODEL = "openai/whisper-large-v3";
const MAX_WAV_BYTES = 24 * 1024 * 1024;

export const MAX_DICTATION_MS = 120_000;

export type DictationStatus = "idle" | "recording" | "transcribing" | "polishing" | "error";

interface AgentHttpResponse {
  status: number;
  body: string;
}

export interface DictationResult {
  text: string;
  cleanupError?: string;
}

export function normalizeDictationSettings(raw: unknown): AgentSettings {
  if (!raw || typeof raw !== "object") {
    return {
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: "",
      dictationStyle: "clean",
    };
  }

  const obj = raw as Record<string, unknown>;
  const provider = obj.provider === "ollama" ? "ollama" : "openrouter";
  const model =
    typeof obj.model === "string" && obj.model
      ? obj.model
      : provider === "ollama"
        ? "qwen2.5:32b"
        : "anthropic/claude-3.5-sonnet";
  const baseUrl =
    typeof obj.baseUrl === "string" && obj.baseUrl
      ? obj.baseUrl
      : provider === "ollama"
        ? OLLAMA_CLOUD_API_BASE_URL
        : OPENROUTER_BASE_URL;
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : "";
  const dictationStyle =
    obj.dictationStyle === "verbatim" || obj.dictationStyle === "command-safe"
      ? obj.dictationStyle
      : "clean";

  return {
    provider,
    model,
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    apiKey,
    dictationStyle,
  };
}

export async function loadDictationSettings(): Promise<AgentSettings> {
  const raw = await invoke<unknown>("load_agent_settings");
  return normalizeDictationSettings(raw);
}

export function validateDictationSettings(settings: AgentSettings | null): string | null {
  if (!settings) return "Configure OpenRouter before dictation.";
  if (settings.provider !== "openrouter") {
    return "Dictation uses OpenRouter. Switch the agent provider to OpenRouter first.";
  }
  if (!settings.apiKey.trim()) return "Add an OpenRouter API key before dictation.";
  return null;
}

function normalizeOpenRouterBaseUrl(settings: AgentSettings): string {
  return (settings.baseUrl.trim() || OPENROUTER_BASE_URL).replace(/\/+$/, "");
}

function openRouterHeaders(settings: AgentSettings): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://wraith.local",
    "X-Title": "Wraith",
    Authorization: `Bearer ${settings.apiKey}`,
  };
}

function apiErrorMessage(response: AgentHttpResponse): string {
  try {
    const body = JSON.parse(response.body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof body.error === "string") return body.error;
    if (typeof body.error?.message === "string") return body.error.message;
    if (typeof body.message === "string") return body.message;
  } catch {
    // Fall through to status/body fallback.
  }
  return `HTTP ${response.status}: ${response.body.slice(0, 240)}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function selectRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ].find((type) => MediaRecorder.isTypeSupported(type));
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function audioBufferToWav(audioBuffer: AudioBuffer): ArrayBuffer {
  const sampleRate = audioBuffer.sampleRate;
  const sampleCount = audioBuffer.length;
  const channelCount = audioBuffer.numberOfChannels;
  const samples = new Float32Array(sampleCount);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] += data[i] / channelCount;
    }
  }

  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + sampleCount * bytesPerSample);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * bytesPerSample, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToWavBase64(blob: Blob): Promise<string> {
  const audioWindow = window as Window &
    typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Audio decoding is not available in this WebView.");
  }

  const encodedAudio = await blob.arrayBuffer();
  const ctx = new AudioContextCtor();
  try {
    const decoded = await ctx.decodeAudioData(encodedAudio.slice(0));
    const wav = audioBufferToWav(decoded);
    if (wav.byteLength > MAX_WAV_BYTES) {
      throw new Error("Recording is too long for dictation upload.");
    }
    return arrayBufferToBase64(wav);
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

function cleanupSystemPrompt(style: DictationStyle, target: "agent" | "terminal"): string {
  const shared = [
    target === "terminal"
      ? "You clean speech dictation for insertion into a terminal prompt."
      : "You clean speech dictation for a developer agent prompt box.",
    "Return only the cleaned text, with no quotes, no commentary, and no markdown wrapper.",
    "Fix punctuation, casing, and obvious speech artifacts without changing intent.",
    "Never answer the prompt. Only rewrite the user's dictated text.",
    "Preserve commands, code, paths, filenames, flags, URLs, package names, symbols, and quoted text exactly when recognizable.",
  ];

  if (style === "command-safe" || target === "terminal") {
    shared.push(
      "Be conservative with technical tokens.",
      "If a token is uncertain, preserve the most literal transcript instead of guessing.",
      "Do not add a final Enter, newline, or instruction to run the command."
    );
  } else {
    shared.push("Remove filler words and false starts when they are clearly not meaningful.");
  }

  return shared.join("\n");
}

async function transcribeAudio(settings: AgentSettings, audioBase64: string): Promise<string> {
  const response = await invoke<AgentHttpResponse>("agent_audio_transcription", {
    url: `${normalizeOpenRouterBaseUrl(settings)}/audio/transcriptions`,
    headers: openRouterHeaders(settings),
    body: {
      model: DICTATION_MODEL,
      input_audio: {
        data: audioBase64,
        format: "wav",
      },
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(apiErrorMessage(response));
  }

  const body = JSON.parse(response.body) as { text?: unknown };
  if (typeof body.text !== "string") {
    throw new Error("Transcription response did not include text.");
  }
  return body.text.trim();
}

async function polishTranscript(
  settings: AgentSettings,
  transcript: string,
  target: "agent" | "terminal"
): Promise<string> {
  if (settings.dictationStyle === "verbatim") return transcript.trim();

  const response = await invoke<AgentHttpResponse>("agent_chat_completion", {
    url: `${normalizeOpenRouterBaseUrl(settings)}/chat/completions`,
    headers: openRouterHeaders(settings),
    body: {
      model: settings.model,
      messages: [
        { role: "system", content: cleanupSystemPrompt(settings.dictationStyle, target) },
        { role: "user", content: transcript },
      ],
      temperature: 0,
      stream: false,
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(apiErrorMessage(response));
  }

  const body = JSON.parse(response.body) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim() : transcript.trim();
}

export async function transcribeDictationBlob(
  settings: AgentSettings,
  blob: Blob,
  target: "agent" | "terminal"
): Promise<DictationResult> {
  if (blob.size === 0) throw new Error("No audio was captured.");

  const audioBase64 = await blobToWavBase64(blob);
  const transcript = await transcribeAudio(settings, audioBase64);
  if (!transcript) throw new Error("No speech was detected.");
  if (settings.dictationStyle === "verbatim") return { text: transcript };

  try {
    return { text: await polishTranscript(settings, transcript, target) };
  } catch (err) {
    return { text: transcript, cleanupError: errorMessage(err) };
  }
}
