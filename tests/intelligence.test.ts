import { describe, expect, it, vi, afterEach } from "vitest";
import {
  activeFacts,
  evaluateDraft,
  generateContent,
  scoreTrend,
  validateVariants,
  type Observation,
} from "../src/lib/intelligence";
import { openingHoursReply, resolveLocalSchedule } from "../src/lib/time";

const now = new Date("2026-11-13T06:10:00Z");
const brand = {
  name: "Juniper Café",
  audience: "Local coffee lovers",
  voice: "Warm, specific and welcoming",
  forbiddenPhrases: ["game changer"],
};
const facts = [
  {
    id: "menu",
    text: "Our iced coffee is brewed daily.",
    approved: true,
    source: "Approved menu",
    validUntil: "2027-01-01T00:00:00Z",
  },
];
const trend = {
  id: "iced",
  topic: "iced coffee",
  evidenceIds: ["search1", "feed1"],
  score: 80,
};
function observation(
  id: string,
  source: string,
  value: number,
  observedAt: string,
  overrides: Partial<Observation> = {},
): Observation {
  return {
    id,
    source,
    externalId: id,
    kind: "search",
    topic: "iced coffee",
    region: "us",
    language: "en",
    metric: "impressions",
    value,
    observedAt,
    collectedAt: now.toISOString(),
    windowStart: observedAt,
    windowEnd: observedAt,
    provenance: "Test fixture",
    ...overrides,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("grounded content generation", () => {
  it("creates three distinct variants with valid references and no outbound call in demo", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const output = await generateContent({
      mode: "demo",
      brand,
      facts,
      trend,
      now,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(output.validation.valid).toBe(true);
    expect(new Set(output.variants.map((v) => v.copy)).size).toBe(3);
    for (const v of output.variants) {
      expect(v.factIds).toEqual(["menu"]);
      expect(v.copy).toContain(facts[0]!.text);
    }
  });
  it("skips expired offers, weak signals, sensitive topics and exhausted budgets", async () => {
    const expired = facts.map((f) => ({
      ...f,
      validUntil: "2026-11-01T00:00:00Z",
    }));
    expect(activeFacts(expired, now)).toEqual([]);
    for (const changes of [
      { facts: expired },
      { trend: { ...trend, score: 20 } },
      { brand: { ...brand, sensitiveTopics: ["iced"] } },
      { budgetRemaining: 0 },
      { recentlyCovered: ["iced coffee"] },
    ]) {
      const output = await generateContent({
        mode: "demo",
        brand,
        facts,
        trend,
        now,
        ...changes,
      });
      expect(output.variants).toHaveLength(0);
      expect(output.brief.skipReason).toBeTruthy();
    }
  });
  it("never falls back to demo when live configuration is missing", async () => {
    await expect(
      generateContent({
        mode: "live",
        brand,
        facts,
        trend,
        now,
        model: { baseUrl: "", model: "", apiKey: "" },
      }),
    ).rejects.toThrow("no fixture was substituted");
  });
  it("tests an OpenAI-compatible request and bounds invalid schema repair to two attempts", async () => {
    const fixture = await generateContent({
      mode: "demo",
      brand,
      facts,
      trend,
      now,
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(fixture) } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const output = await generateContent({
      mode: "live",
      brand,
      facts,
      trend,
      now,
      model: {
        baseUrl: "https://model.example/v1",
        apiKey: "test-key",
        model: "test-model",
      },
    });
    expect(output.modelVersion).toBe("test-model");
    expect(fetch.mock.calls[0]![0].href).toBe(
      "https://model.example/v1/chat/completions",
    );
    expect(
      JSON.parse(fetch.mock.calls[0]![1].body).messages[0].content,
    ).toContain("UNTRUSTED DATA");
    fetch
      .mockReset()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
          ),
      );
    await expect(
      generateContent({
        mode: "live",
        brand,
        facts,
        trend,
        now,
        model: {
          baseUrl: "https://model.example/v1",
          apiKey: "test-key",
          model: "test-model",
        },
      }),
    ).rejects.toThrow("bounded validation");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("blocks unsupported numbers and forbidden phrasing", async () => {
    const generated = await generateContent({
      mode: "demo",
      brand,
      facts,
      trend,
      now,
    });
    generated.variants[0]!.copy += " Only $2! A game changer.";
    const result = validateVariants(generated.variants, brand, facts, now);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /numeric claim.*forbidden phrase|forbidden phrase.*numeric claim/,
    );
  });
  it("keeps deterministic evaluation separate from human ratings", () => {
    expect(evaluateDraft(`Welcome! ${facts[0]!.text}`, facts)).toEqual({
      grounding: 1,
      specificity: 1,
      voice: 1,
      humanRating: null,
    });
  });
});

describe("explainable scoring", () => {
  const rows = [
    observation("s1", "search", 100, "2026-11-13T04:00:00Z"),
    observation("s0", "search", 10, "2026-11-06T04:00:00Z"),
    observation("f1", "feed", 20, "2026-11-13T03:00:00Z", {
      kind: "editorial",
      metric: "mentions",
    }),
    observation("f0", "feed", 2, "2026-11-06T03:00:00Z", {
      kind: "editorial",
      metric: "mentions",
    }),
  ];
  const options = {
    now,
    topic: "iced coffee",
    keywords: ["coffee"],
    region: "us",
  };
  it("surfaces corroborated acceleration with comparable windows and normalized metrics", () => {
    const result = scoreTrend(rows, options);
    expect(result.surfaced).toBe(true);
    expect(result.coldStart).toBe(false);
    expect(result.evidence.map((e) => e.baseline)).toEqual([10, 2]);
    expect(result.measuredLagMs).toBeGreaterThan(0);
  });
  it("deduplicates repeated imports, does not fabricate spikes from empty or stale data", () => {
    expect(scoreTrend([...rows, ...rows], options).score).toBe(
      scoreTrend(rows, options).score,
    );
    expect(scoreTrend([], options).score).toBe(0);
    expect(
      scoreTrend(
        rows.filter((r) => r.id.endsWith("0")),
        options,
      ).surfaced,
    ).toBe(false);
  });
  it("labels missing baseline as cold start and rejects irrelevant or seasonal equal-volume topics", () => {
    expect(
      scoreTrend(
        rows.filter((r) => r.id.endsWith("1")),
        options,
      ).coldStart,
    ).toBe(true);
    expect(scoreTrend(rows, { ...options, keywords: ["cars"] }).surfaced).toBe(
      false,
    );
    const seasonal = rows.map((r) => ({
      ...r,
      value: r.source === "search" ? 100 : 20,
    }));
    expect(scoreTrend(seasonal, options).components.growth).toBe(0);
  });
});

describe("local schedules and midnight answers", () => {
  it("requires a choice for repeated DST times and rejects nonexistent times", () => {
    expect(() =>
      resolveLocalSchedule("2026-03-08T02:30", "America/Chicago"),
    ).toThrow("gap");
    expect(() =>
      resolveLocalSchedule("2026-11-01T01:30", "America/Chicago"),
    ).toThrow("twice");
    const early = resolveLocalSchedule(
      "2026-11-01T01:30",
      "America/Chicago",
      "earlier",
    );
    const late = resolveLocalSchedule(
      "2026-11-01T01:30",
      "America/Chicago",
      "later",
    );
    expect(Date.parse(late.utc) - Date.parse(early.utc)).toBe(3600_000);
  });
  it("resolves tomorrow in brand timezone, uses holiday overrides and escalates unknown hours", () => {
    const reply = openingHoursReply({
      now,
      timezone: "America/Chicago",
      question: "Are you open tomorrow?",
      hours: {
        id: "hours",
        approved: true,
        weekdays: { saturday: "8 AM–5 PM" },
        holidays: { "2026-11-14": "closed for a private event" },
      },
    });
    expect(reply.date).toBe("2026-11-14");
    expect(reply.text).toContain("closed for a private event");
    expect(reply.factIds).toEqual(["hours"]);
    expect(
      openingHoursReply({
        now,
        timezone: "America/Chicago",
        question: "Hours?",
      }).escalate,
    ).toBe(true);
  });
});
