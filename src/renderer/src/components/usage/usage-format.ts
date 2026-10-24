// Display formatting for the Usage page.

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");

export function formatUsd(value: number): string {
  return CURRENCY.format(Number.isFinite(value) ? value : 0);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(Number.isFinite(value) ? value : 0));
}

const TOKEN_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

// Three significant figures with a unit suffix (19.9B, 76.7M, 804K) so columns
// of token counts line up at a glance instead of varying in width.
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  for (let index = 0; index < TOKEN_UNITS.length; index += 1) {
    const [scale, suffix] = TOKEN_UNITS[index];
    if (abs < scale) continue;
    const text = trim(value / scale);
    // Rounding can carry into the next unit (999,999 is "1000K"); the larger
    // unit then reads as 1.
    if (index > 0 && Math.abs(Number(text)) >= 1000) {
      return `${trim(value / TOKEN_UNITS[index - 1][0])}${TOKEN_UNITS[index - 1][1]}`;
    }
    return `${text}${suffix}`;
  }
  const rounded = Math.round(value);
  return Math.abs(rounded) >= 1000 ? formatTokens(rounded) : INTEGER.format(rounded);
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  if (!Number.isFinite(share)) return "0%";
  return `${(share * 100).toFixed(digits)}%`;
}

/**
 * A whole-number share that never rounds a part to nothing or to everything:
 * output is often 0.4% of a cache-heavy mix, and "0%" beside a visible
 * segment reads as a bug.
 */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  if (share >= 1) return "100%";
  if (share < 0.01) return "<1%";
  if (share > 0.99) return ">99%";
  return `${Math.round(share * 100)}%`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `2026-08-07` to `Aug 7`, or `Aug 7, 2026` with the year. */
export function formatDayShort(day: string, withYear = false): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (!year || !month || !dayOfMonth) return day;
  const short = `${MONTHS[month - 1] ?? ""} ${dayOfMonth}`;
  return withYear ? `${short}, ${year}` : short;
}

/** Whether two `YYYY-MM-DD` days fall in different calendar years. */
export function spansYears(sinceDay: string, untilDay: string): boolean {
  return sinceDay.slice(0, 4) !== untilDay.slice(0, 4);
}

/**
 * `Sep 15 to Oct 14`, with both years once the range crosses one: a one-year
 * window otherwise reads `Oct 15 to Oct 14`.
 */
export function formatDayRange(sinceDay: string, untilDay: string): string {
  const withYear = spansYears(sinceDay, untilDay);
  return `${formatDayShort(sinceDay, withYear)} to ${formatDayShort(untilDay, withYear)}`;
}
