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

// Three significant figures with a unit suffix (19.9B, 76.7M, 804K) so columns
// of token counts line up at a glance instead of varying in width.
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
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

/** `2026-08-07` to `Aug 7`. */
export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (!year || !month || !dayOfMonth) return day;
  return `${MONTHS[month - 1] ?? ""} ${dayOfMonth}`;
}
