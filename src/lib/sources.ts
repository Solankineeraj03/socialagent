import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { parse } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { DateTime } from "luxon";
import type { Observation } from "./intelligence";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const numericMetric = z
  .union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .pipe(z.number().nonnegative().finite());
const csvRow = z.object({
  query: z.string().min(1).max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  impressions: numericMetric,
  clicks: numericMetric.optional(),
  country: z.string().default("global"),
  language: z.string().default("und"),
});
export function importSearchCsv(
  csv: string,
  options: { property?: string; source?: string; now?: Date | string } = {},
): Observation[] {
  if (Buffer.byteLength(csv) > 2_000_000)
    throw new Error("CSV exceeds 2 MB limit");
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
    max_record_size: 10_000,
  }) as unknown[];
  if (records.length > 10_000) throw new Error("CSV exceeds 10,000 rows");
  const source =
    options.source ?? `search-console:${options.property ?? "csv-import"}`;
  const collectedAt = new Date(options.now ?? new Date()).toISOString();
  const rows = records.map((raw) => {
    const row = csvRow.parse(raw);
    // Search Console daily dimensions are Pacific Time, including DST.
    const day = DateTime.fromISO(row.date, { zone: "America/Los_Angeles" });
    if (!day.isValid || day.toISODate() !== row.date)
      throw new Error(`Invalid calendar date ${row.date}`);
    const start = day.toJSDate();
    if (start.getTime() > Date.parse(collectedAt))
      throw new Error("Future observations are not allowed");
    const externalId = digest(
      `${source}|${row.query.toLowerCase()}|${row.date}|${row.country}`,
    );
    return {
      id: externalId,
      source,
      externalId,
      kind: "search" as const,
      topic: row.query.toLowerCase(),
      region: row.country,
      language: row.language,
      metric: "impressions",
      value: row.impressions,
      observedAt: start.toISOString(),
      collectedAt,
      windowStart: start.toISOString(),
      windowEnd: day.plus({ days: 1 }).toUTC().toISO()!,
      provenance: `Authorized Search Console export; owned-property coverage only: ${options.property ?? "not specified"}; date window in America/Los_Angeles; reporting delay and top-row limitations apply.`,
    };
  });
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

/** Reject local, reserved, multicast, link-local and IPv4-mapped destinations. */
export function isPublicAddress(address: string): boolean {
  const addr = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(addr) === 4) {
    const octets = addr.split(".").map(Number);
    const a = octets[0]!;
    const b = octets[1]!;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(addr) === 6)
    return (
      !/^(?:0*:|::|f[cd]|fe[89ab]|ff|2001:db8|2001:0:|2002:)/i.test(addr) &&
      !addr.includes("ffff:")
    );
  return false;
}

export async function fetchPermittedFeed(
  endpoint: string,
  permittedEndpoints: string[],
): Promise<string> {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error(
      "Feeds require a credential-free HTTPS endpoint on port 443",
    );
  if (!permittedEndpoints.some((allowed) => new URL(allowed).href === url.href))
    throw new Error("Feed endpoint has not been explicitly permitted");
  const addresses = await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((entry) => !isPublicAddress(entry.address))
  )
    throw new Error("Feed DNS resolved to a private or reserved network");
  const selected = addresses[0]!;
  // Pin the approved address in the actual TLS connection; never re-resolve after validation.
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: {
          accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml",
          "user-agent": "SocialAgent/1.0 (permitted feed reader)",
        },
        lookup: (_hostname, _opts, cb) =>
          cb(null, selected.address, selected.family),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(
              `Feed returned HTTP ${res.statusCode}; redirects are not followed`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 2_000_000)
            req.destroy(new Error("Feed exceeds 2 MB limit"));
          else chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    req.setTimeout(10_000, () =>
      req.destroy(new Error("Feed request timed out")),
    );
    const deadline = setTimeout(
      () => req.destroy(new Error("Feed exceeded total request deadline")),
      15_000,
    );
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end();
  });
}

const plainText = (value: unknown): string =>
  (typeof value === "string"
    ? value
    : typeof value === "object" && value && "#text" in value
      ? String(value["#text"])
      : ""
  )
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
function canonicalUrl(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return undefined;
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (k.startsWith("utm_") || ["fbclid", "gclid"].includes(k))
        u.searchParams.delete(k);
    return u.href.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
export function parseFeed(
  xml: string,
  options: {
    endpoint: string;
    now?: Date | string;
    region?: string;
    language?: string;
    topic?: string;
    maxBackfillDays?: number;
  },
): Observation[] {
  if (Buffer.byteLength(xml) > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error(
      "Feed contains forbidden declarations or exceeds size limit",
    );
  const parser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    isArray: (name) => ["item", "entry", "link"].includes(name),
  });
  const data = parser.parse(xml) as {
    rss?: { channel?: { item?: Record<string, unknown>[] } };
    feed?: { entry?: Record<string, unknown>[] };
  };
  const entries = data.rss?.channel?.item ?? data.feed?.entry ?? [];
  const collected = new Date(options.now ?? new Date());
  const source = `feed:${options.endpoint}`;
  const items: Observation[] = [];
  for (const entry of entries.slice(0, 1000)) {
    const title = plainText(entry.title).slice(0, 500);
    const observed = new Date(
      plainText(entry.pubDate ?? entry.published ?? entry.updated),
    );
    if (
      !title ||
      Number.isNaN(observed.getTime()) ||
      observed > collected ||
      collected.getTime() - observed.getTime() >
        (options.maxBackfillDays ?? 30) * 86400_000
    )
      continue;
    const links = Array.isArray(entry.link) ? entry.link : [entry.link];
    const link = links.find(
      (l) =>
        typeof l === "string" ||
        (typeof l === "object" &&
          l &&
          (!("@_rel" in l) || l["@_rel"] === "alternate")),
    );
    const url = canonicalUrl(
      typeof link === "string"
        ? link
        : link && typeof link === "object" && "@_href" in link
          ? String(link["@_href"])
          : "",
    );
    const externalId =
      plainText(entry.guid ?? entry.id) || url || digest(title);
    const id = digest(`${url ?? `${source}|${externalId}`}`);
    items.push({
      id,
      source,
      externalId,
      kind: "editorial",
      topic: options.topic ?? title.toLowerCase(),
      region: options.region ?? "global",
      language: options.language ?? "und",
      metric: "editorial_mentions",
      value: 1,
      observedAt: observed.toISOString(),
      collectedAt: collected.toISOString(),
      windowStart: observed.toISOString(),
      windowEnd: new Date(observed.getTime() + 1).toISOString(),
      url,
      independentSource: url
        ? new URL(url).hostname
        : new URL(options.endpoint).hostname,
      provenance: `Permitted RSS/Atom endpoint ${options.endpoint}; title: ${title}; editorial mentions are not search-volume estimates.`,
    });
  }
  return [...new Map(items.map((o) => [o.id, o])).values()];
}

export async function readSearchConsole(options: {
  accessToken: string;
  property: string;
  startDate: string;
  endDate: string;
  startRow?: number;
}): Promise<{ observations: Observation[]; nextCursor: number | null }> {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(options.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(options.endDate) ||
    !Number.isFinite(Date.parse(options.startDate)) ||
    !Number.isFinite(Date.parse(options.endDate)) ||
    Date.parse(options.endDate) < Date.parse(options.startDate)
  )
    throw new Error("Invalid Search Console date range");
  if (
    options.startRow !== undefined &&
    (!Number.isInteger(options.startRow) ||
      options.startRow < 0 ||
      options.startRow > 100_000)
  )
    throw new Error("Search Console cursor exceeds bounded pagination");
  if (
    Date.parse(options.endDate) - Date.parse(options.startDate) >
    31 * 86400_000
  )
    throw new Error(
      "Search Console backfill is limited to 31 days per request",
    );
  const response = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(options.property)}/searchAnalytics/query`,
    {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        startDate: options.startDate,
        endDate: options.endDate,
        dimensions: ["query", "date", "country"],
        rowLimit: 1000,
        startRow: options.startRow ?? 0,
        dataState: "final",
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Search Console HTTP ${response.status}; previous cursor must remain unchanged`,
    );
  const data = (await response.json()) as {
    rows?: { keys: string[]; impressions: number; clicks: number }[];
  };
  const rows = data.rows ?? [];
  const csv =
    "query,date,country,impressions,clicks\n" +
    rows
      .map((row) =>
        [row.keys[0], row.keys[1], row.keys[2], row.impressions, row.clicks]
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(","),
      )
      .join("\n");
  return {
    observations: importSearchCsv(csv, { property: options.property }),
    nextCursor: rows.length === 1000 ? (options.startRow ?? 0) + 1000 : null,
  };
}
