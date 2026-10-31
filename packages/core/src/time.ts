/**
 * Market time. US equity sessions are defined in America/New_York; everything
 * we store is a UTC instant. Workers and Node both ship full Intl tz data.
 */
export const MARKET_TZ = "America/New_York";

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The New York calendar date (YYYY-MM-DD) of an instant. */
export function marketDate(instant: Date): string {
  return dateFmt.format(instant);
}

const offsetFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  timeZoneName: "longOffset",
});

/** New York's UTC offset in minutes at an instant, e.g. -240 (EDT) or -300 (EST). */
function offsetMinutes(instant: Date): number {
  const name = offsetFmt.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (!m) return 0; // "GMT" alone means +00:00
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

/**
 * A New York wall-clock time ("16:00" or "1600") on a date → UTC instant.
 * DST changes happen at 02:00, so the offset at the target time itself is
 * found by one correction step from a first guess.
 */
export function marketTimeToUtc(date: string, time: string): Date {
  const hhmm = time.replace(":", "");
  const naiveUtc = Date.parse(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`);
  if (Number.isNaN(naiveUtc)) throw new RangeError(`bad market time: ${date} ${time}`);
  const guess = naiveUtc - offsetMinutes(new Date(naiveUtc)) * 60_000;
  return new Date(naiveUtc - offsetMinutes(new Date(guess)) * 60_000);
}

const displayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Tue, Nov 3, 10:15 AM ET": instants as people read them in emails. */
export function formatMarketTime(instant: Date): string {
  return `${displayFmt.format(instant)} ET`;
}
