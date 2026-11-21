export type SpeechTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export async function elevenLabsSpeech(
  text: string,
  config: { apiKey: string; voiceId: string; model?: string },
  transport: SpeechTransport = fetch,
) {
  if (!config.apiKey)
    throw Error(
      "ELEVENLABS_API_KEY is required; no fallback voice is substituted",
    );
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(config.voiceId))
    throw Error("Invalid ElevenLabs voice ID");
  if (!text.trim() || text.length > 5000)
    throw Error("Narration must contain 1–5000 characters");
  const response = await transport(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      signal: AbortSignal.timeout(90000),
      headers: {
        "xi-api-key": config.apiKey,
        "Content-Type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: config.model ?? "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
      }),
    },
  );
  if (!response.ok)
    throw Error(
      `ElevenLabs returned HTTP ${response.status}. Check key permissions, voice access and credit balance. No automatic paid retry was made.`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100 || bytes.length > 20000000)
    throw Error("Invalid speech response size");
  return bytes;
}
