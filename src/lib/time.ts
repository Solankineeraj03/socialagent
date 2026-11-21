import { DateTime } from "luxon";

export function resolveLocalSchedule(
  local: string,
  timezone: string,
  fold?: "earlier" | "later",
): { utc: string; timezone: string; local: string; offsetMinutes: number } {
  const parsed = DateTime.fromISO(local, { zone: timezone });
  if (!parsed.isValid)
    throw new Error(
      `Invalid local schedule or IANA timezone: ${parsed.invalidExplanation}`,
    );
  const requested = local.slice(0, 16);
  if (parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== requested)
    throw new Error(
      "This local time falls in a daylight-saving gap. Choose a valid time.",
    );
  const candidates = parsed
    .getPossibleOffsets()
    .sort((a, b) => a.toMillis() - b.toMillis());
  if (candidates.length > 1 && !fold)
    throw new Error(
      "This local time occurs twice. Choose earlier or later explicitly.",
    );
  const selected = fold === "later" ? candidates.at(-1)! : candidates[0]!;
  return {
    utc: selected.toUTC().toISO()!,
    timezone,
    local: requested,
    offsetMinutes: selected.offset,
  };
}

export interface HoursFact {
  id: string;
  approved: boolean;
  weekdays: Partial<Record<string, string>>;
  holidays?: Record<string, string>;
  validUntil?: string;
}
export function openingHoursReply(input: {
  now: Date | string;
  timezone: string;
  question: string;
  hours?: HoursFact;
}) {
  const now = DateTime.fromJSDate(new Date(input.now), {
    zone: input.timezone,
  });
  if (!now.isValid) throw new Error("Invalid brand timezone");
  const target = /tomorrow/i.test(input.question) ? now.plus({ days: 1 }) : now;
  const date = target.toISODate()!;
  const weekday = target.toFormat("cccc").toLowerCase();
  if (
    !input.hours?.approved ||
    (input.hours.validUntil &&
      Date.parse(input.hours.validUntil) <= new Date(input.now).getTime())
  )
    return {
      text: "I’ll ask our team to confirm the opening hours for you.",
      escalate: true,
      date,
      factIds: [],
    };
  const hours = input.hours.holidays?.[date] ?? input.hours.weekdays[weekday];
  if (!hours)
    return {
      text: "I’ll ask our team to confirm the opening hours for you.",
      escalate: true,
      date,
      factIds: [],
    };
  return {
    text: `For ${target.toFormat("cccc, LLLL d")} (${date}), our hours are ${hours}.`,
    escalate: false,
    date,
    factIds: [input.hours.id],
  };
}
