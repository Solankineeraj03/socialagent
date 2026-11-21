import { describe, expect, it } from "vitest";
import {
  fetchPermittedFeed,
  importSearchCsv,
  isPublicAddress,
  parseFeed,
} from "../src/lib/sources";

describe("search importer", () => {
  it("normalizes and deduplicates identical rows with deterministic identities", () => {
    const csv =
      "query,date,impressions,clicks,country\niced coffee,2026-11-12,100,10,us\niced coffee,2026-11-12,100,10,us";
    const rows = importSearchCsv(csv, {
      property: "https://cafe.example",
      now: "2026-11-13T00:00:00Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("search");
    expect(rows[0]!.value).toBe(100);
    expect(
      importSearchCsv(csv, {
        property: "https://cafe.example",
        now: "2026-11-14T00:00:00Z",
      })[0]!.id,
    ).toBe(rows[0]!.id);
    expect(rows[0]!.provenance).toContain("owned-property");
  });
  it("rejects missing/negative metrics, future and invalid dates", () => {
    for (const row of [
      "coffee,2026-11-12,-1",
      "coffee,2026-02-30,5",
      "coffee,2099-01-01,5",
    ])
      expect(() =>
        importSearchCsv(`query,date,impressions\n${row}`, {
          now: "2026-11-13",
        }),
      ).toThrow();
  });
});
describe("feed safety and normalization", () => {
  it("rejects private, reserved and mapped addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.2",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("requires endpoint permission and HTTPS before any network access", async () => {
    await expect(
      fetchPermittedFeed("http://localhost/feed", []),
    ).rejects.toThrow("HTTPS");
    await expect(
      fetchPermittedFeed("https://example.com/feed", []),
    ).rejects.toThrow("explicitly permitted");
  });
  it("parses RSS and Atom, canonicalizes syndication links, and ignores missing/old dates", () => {
    const options = {
      endpoint: "https://news.example/feed",
      now: "2026-11-13T12:00:00Z",
      topic: "iced coffee",
    };
    const rss =
      "<rss><channel><item><title>Iced coffee interest</title><link>https://news.example/story?utm_source=x</link><guid>1</guid><pubDate>Thu, 12 Nov 2026 12:00:00 GMT</pubDate></item><item><title>Undated story</title></item></channel></rss>";
    const rows = parseFeed(rss, options);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe("https://news.example/story");
    expect(rows[0]!.kind).toBe("editorial");
    const atom =
      '<feed><entry><title>Iced coffee interest</title><id>2</id><link href="https://news.example/story" rel="alternate"/><updated>2026-11-12T12:00:00Z</updated></entry></feed>';
    expect(parseFeed(atom, options)[0]!.id).toBe(rows[0]!.id);
  });
  it("rejects entity expansion", () => {
    expect(() =>
      parseFeed(
        '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
        { endpoint: "https://example.com" },
      ),
    ).toThrow("forbidden declarations");
  });
});
