import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, it, expect } from "vitest";
import { renderMedia, probeVideo, wrapText } from "../src/lib/media";

describe("real media renderer", () => {
  it("detects overflowing titles and supports absent logos", () => {
    expect(wrapText("A gentle start to the day", 14, 3)).toEqual([
      "A gentle start",
      "to the day",
    ]);
    expect(() => wrapText("word ".repeat(100), 24, 4)).toThrow("overflow");
  });
  it("renders actual decodable PNG and H.264 MP4; verifies cached checksums and immutable inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socialagent-media-"));
    try {
      const input = {
        outputDir: dir,
        brand: { name: "Juniper Café" },
        title: "A cooler kind of coffee",
        subtitle: "Brewed for the little moments.",
        scenes: [
          { text: "A cooler kind of coffee", durationSeconds: 2 },
          { text: "A moment at Juniper Café", durationSeconds: 2 },
        ],
      };
      const result = await renderMedia(input);
      const metadata = await sharp(result.imagePath).metadata();
      expect([metadata.width, metadata.height]).toEqual([1080, 1350]);
      const video = await probeVideo(result.videoPath);
      expect(video.duration).toBeCloseTo(4, 1);
      expect(video.codec_name).toBe("h264");
      expect(result.manifest.files).toHaveLength(5);
      expect(result.manifest.illustration).toBe(true);
      expect((await readFile(result.videoPath)).length).toBeGreaterThan(1000);
      expect((await renderMedia(input)).manifest.inputHash).toBe(
        result.manifest.inputHash,
      );
      await expect(
        renderMedia({ ...input, title: "Changed input" }),
      ).rejects.toThrow("Immutable");
      await expect(
        renderMedia({
          ...input,
          outputDir: join(dir, "missing"),
          sourcePhotoPath: "/does-not-exist/photo.png",
        }),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
