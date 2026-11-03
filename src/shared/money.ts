// Money shown in euros with the dollar amount beside it. Spend and caps are
// recorded and stored in USD; only what is displayed and typed is euros, at
// the ECB daily reference rate. Pure (no Electron, no network) so the main
// process, the renderer and scripts/test-money.cjs all share one conversion.

export interface MoneyRate {
  /** US dollars per euro, as the ECB publishes it. */
  usdPerEur: number;
  /** The day the rate is for (YYYY-MM-DD), or "built-in" for the constant. */
  date: string;
  source: "ecb" | "cache" | "built-in";
}

/** ECB reference rate for 2026-11-02, used until a rate has ever been fetched. */
export const BUILT_IN_RATE: MoneyRate = { usdPerEur: 1.1216, date: "2026-11-02", source: "built-in" };

let current: MoneyRate = BUILT_IN_RATE;

export function setMoneyRate(rate: MoneyRate | undefined): void {
  current = rate && isUsableRate(rate.usdPerEur) ? rate : BUILT_IN_RATE;
}

export function moneyRate(): MoneyRate {
  return current;
}

export function isUsableRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0.3 && value < 3;
}

/** Reads the USD rate and its day out of the ECB daily XML. */
export function parseEcbDaily(xml: string): MoneyRate | null {
  const rate = /<Cube\s+currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/.exec(xml);
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml);
  if (!rate || !date) return null;
  const usdPerEur = Number(rate[1]);
  return isUsableRate(usdPerEur) ? { usdPerEur, date: date[1], source: "ecb" } : null;
}

const round = (value: number, places: number): number => {
  const k = 10 ** places;
  return Math.round((value + Number.EPSILON) * k) / k;
};

const MIN_USD = 0.0001;
const MAX_EUR = 1e12;

export function usdToEur(usd: number, rate: MoneyRate = current): number {
  return usd / rate.usdPerEur;
}

/** Four places, so a euro cap typed to the cent comes back to the same cent. */
export function eurToUsd(eur: number, rate: MoneyRate = current): number {
  return round(eur * rate.usdPerEur, 4);
}

const clean = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function fmtEur(usd: number | undefined, rate: MoneyRate = current): string {
  return `€${usdToEur(clean(usd), rate).toFixed(2)}`;
}

export function fmtDollar(usd: number | undefined): string {
  return `$${clean(usd).toFixed(2)}`;
}

/** "≈€1.72 ($2.00)": euros first, the stored dollars after in brackets. The
 *  renderer shows the bracketed part small and muted. `approx: false` drops the
 *  sign where the sentence already says "about" or "est.". */
export function fmtMoney(usd: number | undefined, opts: { approx?: boolean; rate?: MoneyRate } = {}): string {
  const rate = opts.rate ?? current;
  return `${opts.approx === false ? "" : "≈"}${fmtEur(usd, rate)} (${fmtDollar(usd)})`;
}

/** The bracketed dollar part of a fmtMoney string. */
export const MONEY_USD_PART = /\(\$[0-9,]+\.\d{2}\)/g;

export function rateNote(rate: MoneyRate = current): string {
  const day = rate.source === "built-in" ? "built-in rate, not fetched yet" : `ECB rate of ${rate.date}${rate.source === "cache" ? ", last fetched" : ""}`;
  return `1 € = $${rate.usdPerEur.toFixed(4)} (${day})`;
}

/** What a euro field shows for a stored dollar amount: "1.72", no trailing zeros. */
export function eurFieldFromUsd(usd: number, rate: MoneyRate = current): string {
  const eur = usdToEur(usd, rate);
  const cents = round(eur, 2);
  // A tiny limit must not read as 0, which the editor rejects as "no limit".
  return String(cents === 0 && usd > 0 ? Number(eur.toPrecision(2)) : cents);
}

/** The dollars to store for a euro field, or undefined when it is not a positive number. */
export function usdFromEurField(text: string, rate: MoneyRate = current): number | undefined {
  // Capped so an absurd amount stays a (huge) limit instead of overflowing to Infinity.
  const value = Math.min(MAX_EUR, Number(text.trim().replace(",", ".")));
  // A positive amount too small to register is still a limit, never "no limit".
  return text.trim() && Number.isFinite(value) && value > 0 ? Math.max(MIN_USD, eurToUsd(value, rate)) : undefined;
}

/** A saved amount as the editor first showed it. */
export interface ShownLimit {
  usd: number;
  /** The euro text the field held when it opened. */
  shown: string;
}

export function shownLimit(usd: number, rate: MoneyRate = current): ShownLimit {
  return { usd, shown: eurFieldFromUsd(usd, rate) };
}

/** Like usdFromEurField, but a field left as it was first shown keeps the stored
 *  dollars exactly: opening a saved cap and saving something else must not nudge
 *  it by a euro cent's rounding, nor by a rate that arrived in between. */
export function usdFromEurFieldKeeping(text: string, kept: ShownLimit | undefined, rate: MoneyRate = current): number | undefined {
  if (kept && text.trim() === kept.shown) return kept.usd;
  return usdFromEurField(text, rate);
}
