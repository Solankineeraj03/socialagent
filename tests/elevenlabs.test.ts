import { describe, it, expect, vi } from "vitest";
import { elevenLabsSpeech } from "../src/lib/elevenlabs";
import { DEMO_STORY } from "../src/lib/demo-story";
describe("ElevenLabs narration contract", () => {
  it("uses server-side key and the selected voice with bounded narration", async () => {
    const transport = vi.fn(
      async () =>
        new Response(Buffer.alloc(1000), {
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    const audio = await elevenLabsSpeech(
      "A fictional café demo.",
      { apiKey: "fixture-only", voiceId: "JBFqnCBsd6RMkjVDRZzb" },
      transport,
    );
    expect(audio.length).toBe(1000);
    const [url, request] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb");
    expect(request.headers).toMatchObject({ "xi-api-key": "fixture-only" });
    expect(JSON.parse(String(request.body))).toMatchObject({
      model_id: "eleven_multilingual_v2",
      text: "A fictional café demo.",
    });
  });
  it("does not call a provider without a key or silently substitute a voice", async () => {
    const transport = vi.fn();
    await expect(
      elevenLabsSpeech(
        "Hello",
        { apiKey: "", voiceId: "JBFqnCBsd6RMkjVDRZzb" },
        transport,
      ),
    ).rejects.toThrow("no fallback");
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not echo provider response bodies or retry paid calls", async () => {
    const transport = vi.fn(
      async () => new Response("sensitive provider response", { status: 401 }),
    );
    await expect(
      elevenLabsSpeech(
        "Hello",
        { apiKey: "secret-fixture", voiceId: "JBFqnCBsd6RMkjVDRZzb" },
        transport,
      ),
    ).rejects.toThrow("HTTP 401");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("keeps the demo fictional and explicitly discloses simulated publication", () => {
    expect(DEMO_STORY).toHaveLength(8);
    expect(DEMO_STORY.map((s) => s.text).join(" ")).toMatch(
      /simulated receipt/,
    );
    expect(DEMO_STORY.map((s) => s.text).join(" ")).toMatch(/fictional/);
  });
});
