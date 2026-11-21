import { hash } from "bcryptjs";
import { pool, transaction, DEMO_ORG, SECOND_ORG } from "../src/server/db.js";
export const DEMO_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SECOND_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export async function seed() {
  if (process.env.APP_MODE === "live")
    throw new Error("Demo seed is disabled in live mode");
  const password = await hash("demo-social-2026", 12);
  await transaction(async (db) => {
    for (const [id, email] of [
      [DEMO_USER, "demo@local.test"],
      [SECOND_USER, "second@local.test"],
    ])
      await db.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [id, email, password],
      );
    const brand = {
      name: "Daybreak Coffee",
      industry: "Neighborhood café",
      audience: "Curious coffee drinkers and neighbors in Austin",
      locations: ["Austin, Texas"],
      timezone: "America/Chicago",
      languages: ["en"],
      voice:
        "Warm, curious, specific. A good neighbor who knows their coffee. Short sentences. No hype.",
      goals: ["Build neighborhood connections", "Share our coffee craft"],
      contentPillars: ["Coffee craft", "Community", "Slow mornings"],
      postingWindows: ["09:00", "15:00"],
      cadence: 3,
      palette: ["#1b3a2e", "#f8f0dd", "#e9ae54"],
      fonts: ["DejaVu Sans"],
      cta: "Drop by and say hello.",
      forbiddenPhrases: [
        "best coffee in the world",
        "guaranteed",
        "limited-time offer",
      ],
      sensitiveTopics: ["politics", "medical advice"],
      hours: {
        Monday: "07:00–18:00",
        Tuesday: "07:00–18:00",
        Wednesday: "07:00–18:00",
        Thursday: "07:00–18:00",
        Friday: "07:00–18:00",
        Saturday: "08:00–17:00",
        Sunday: "08:00–16:00",
      },
      holidayOverrides: { "2026-11-26": "Closed" },
    };
    for (const [id, name, b] of [
      [DEMO_ORG, "Daybreak Coffee", brand],
      [
        SECOND_ORG,
        "Juniper Studio",
        { ...brand, name: "Juniper Studio", industry: "Ceramics studio" },
      ],
    ] as const) {
      await db.query(
        "INSERT INTO organizations(id,name,mode,clock_at,brand) VALUES($1,$2,'demo','2026-11-13T15:00:00Z',$3) ON CONFLICT DO NOTHING",
        [id, name, JSON.stringify(b)],
      );
    }
    await db.query(
      "INSERT INTO memberships VALUES($1,$2,'owner'),($3,$4,'owner') ON CONFLICT DO NOTHING",
      [DEMO_ORG, DEMO_USER, SECOND_ORG, SECOND_USER],
    );
    for (const org of [DEMO_ORG, SECOND_ORG]) {
      const existing = await db.query(
        "SELECT 1 FROM entities WHERE org_id=$1 LIMIT 1",
        [org],
      );
      if (existing.rowCount) continue;
      for (const channel of ["instagram", "youtube", "linkedin"])
        await db.query(
          "INSERT INTO connections(org_id,channel,account_id,account_name,status,capabilities,last_health_at) VALUES($1,$2,$3,$4,'demo',$5,now()) ON CONFLICT DO NOTHING",
          [
            org,
            channel,
            `demo-${channel}`,
            org === DEMO_ORG ? "Daybreak Coffee" : "Juniper Studio",
            JSON.stringify({
              publish: "demo only",
              inbox:
                channel === "youtube"
                  ? "Comments"
                  : channel === "linkedin"
                    ? "Comments; private messaging unsupported"
                    : "DMs and comments (demo)",
            }),
          ],
        );
      const facts = [
        {
          text: "Our iced coffee is steeped slowly for 18 hours and served over ice.",
          approved: true,
          source: "Owner-approved café menu",
          owner: "Café owner",
          reviewedAt: "2026-11-01",
          validFrom: "2026-01-01",
          validUntil: "2027-12-31",
          category: "menu",
        },
        {
          text: "Daybreak Coffee is in Austin, Texas. We welcome neighbors to share a slow morning.",
          approved: true,
          source: "Owner-approved brand handbook",
          owner: "Café owner",
          reviewedAt: "2026-11-01",
          validUntil: "2027-12-31",
          category: "about",
        },
        {
          text: "Opening hours: Monday–Friday 07:00–18:00, Saturday 08:00–17:00, Sunday 08:00–16:00 America/Chicago. Closed November 26, 2026.",
          approved: true,
          source: "Owner-approved operating hours",
          owner: "Café owner",
          reviewedAt: "2026-11-01",
          validUntil: "2027-12-31",
          category: "hours",
        },
        {
          text: "Iced coffee is $3 during the summer offer.",
          approved: true,
          source: "Expired summer offer",
          owner: "Café owner",
          reviewedAt: "2026-05-01",
          validUntil: "2026-09-01",
          category: "price",
        },
      ];
      for (const data of facts)
        await db.query(
          "INSERT INTO entities(org_id,kind,data) VALUES($1,'fact',$2)",
          [org, JSON.stringify(data)],
        );
      await db.query(
        "INSERT INTO entities(org_id,kind,data) VALUES($1,'style',$2)",
        [
          org,
          JSON.stringify({
            text: "Good things take a little time. Ours takes 18 hours. Meet your new slow-morning ritual.",
            approved: true,
            kind: "loved",
            source: "Owner voice calibration",
          }),
        ],
      );
      const topics = [
        {
          topic: "Iced coffee rituals",
          score: 88,
          status: "rising",
          recentCount: 84,
          baselineCount: 24,
          growth: 2.5,
          freshness: 0.95,
          relevance: 1,
          independentSources: 2,
          coldStart: false,
          reason:
            "Search interest is 3.5× its previous comparable window, corroborated by two independent industry mentions.",
          kind: "search interest",
          region: "US-TX",
          observedAt: "2026-11-13T14:00:00Z",
          collectedAt: "2026-11-13T14:05:00Z",
          window: "7 days compared with previous 7 days",
          sources: ["Owned-property search CSV", "Coffee Journal RSS"],
          evidenceIds: [],
          provenance: "Locally generated deterministic demo signals",
        },
        {
          topic: "Slow mornings at neighborhood cafés",
          score: 76,
          status: "rising",
          recentCount: 35,
          baselineCount: 15,
          growth: 1.33,
          freshness: 0.9,
          relevance: 0.95,
          independentSources: 2,
          coldStart: false,
          reason:
            "Two independent editorial sources and audience questions; strong community relevance.",
          kind: "editorial mentions",
          region: "US",
          observedAt: "2026-11-13T12:00:00Z",
          collectedAt: "2026-11-13T12:10:00Z",
          window: "7 days",
          sources: ["Neighborhood RSS", "Owned-channel comments"],
        },
        {
          topic: "Summer cold brew sale",
          score: 21,
          status: "stale",
          recentCount: 2,
          baselineCount: 25,
          growth: -0.92,
          freshness: 0.1,
          relevance: 0.8,
          independentSources: 1,
          reason:
            "Last observation is older than the freshness window. Expired pricing evidence.",
          kind: "search interest",
          region: "US-TX",
          observedAt: "2026-09-01T12:00:00Z",
          sources: ["Owned-property search CSV"],
        },
        {
          topic: "Celebrity gadget launch",
          score: 12,
          status: "irrelevant",
          recentCount: 300,
          baselineCount: 40,
          growth: 6.5,
          freshness: 0.99,
          relevance: 0.01,
          independentSources: 4,
          reason:
            "High growth, but unrelated to the café’s audience and content pillars.",
          kind: "editorial mentions",
          region: "US",
          observedAt: "2026-11-13T14:00:00Z",
          sources: ["Technology RSS"],
        },
        {
          topic: "Pumpkin spice season",
          score: 40,
          status: "seasonal",
          recentCount: 90,
          baselineCount: 85,
          growth: 0.06,
          freshness: 0.8,
          relevance: 0.7,
          independentSources: 2,
          reason: "Seasonal baseline is already high; no unusual acceleration.",
          kind: "search interest",
          region: "US",
          observedAt: "2026-11-13T11:00:00Z",
          sources: ["Owned-property search CSV"],
        },
        {
          topic: "Coffee press release",
          score: 18,
          status: "syndicated",
          recentCount: 12,
          baselineCount: 3,
          growth: 3,
          freshness: 0.9,
          relevance: 0.7,
          independentSources: 1,
          reason:
            "Twelve copies of the same syndicated article count as one independent source.",
          kind: "editorial mentions",
          region: "US",
          observedAt: "2026-11-13T14:00:00Z",
          sources: ["Syndicated RSS"],
        },
      ];
      for (const topic of topics)
        await db.query(
          "INSERT INTO entities(org_id,kind,data) VALUES($1,'trend',$2)",
          [org, JSON.stringify(topic)],
        );
      await db.query(
        "INSERT INTO entities(org_id,kind,data) VALUES($1,'scoring_config',$2)",
        [
          org,
          JSON.stringify({
            version: 1,
            threshold: 60,
            minimumCount: 5,
            weights: {
              growth: 0.3,
              freshness: 0.2,
              corroboration: 0.2,
              relevance: 0.3,
            },
            cooldownHours: 48,
          }),
        ],
      );
      for (const source of ["Owned-property search CSV", "Coffee Journal RSS"])
        await db.query(
          "INSERT INTO source_cursors(org_id,source,last_success_at,config) VALUES($1,$2,'2026-11-13T14:05:00Z',$3)",
          [
            org,
            source,
            JSON.stringify({
              demo: true,
              coverage: source.includes("search")
                ? "Connected property only; reporting delay applies"
                : "Configured industry feeds",
              pollMinutes: 60,
            }),
          ],
        );
    }
  });
  console.log(
    "Seeded two isolated demo organizations. Login: demo@local.test / demo-social-2026",
  );
}
if (process.argv[1]?.endsWith("seed.ts"))
  seed()
    .then(() => pool.end())
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
      void pool.end();
    });
