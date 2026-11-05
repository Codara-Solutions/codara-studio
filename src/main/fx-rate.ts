import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-atomic";
import { BUILT_IN_RATE, isUsableRate, parseEcbDaily, setMoneyRate, type MoneyRate } from "../shared/money";

// The euro rate behind the Automations money display. One ECB request per
// day at most, kept in Studio's own data dir; offline or on a bad answer the
// last cached rate stands, then the built-in constant. No keys, no other hosts.

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const CACHE_FILE = "fx-rate.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

interface CacheFile {
  usdPerEur: number;
  date: string;
  fetchedAt: number;
}

export interface FxDeps {
  dir: string;
  now?: () => number;
  fetchText?: (url: string) => Promise<string>;
}

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ECB answered ${res.status}`);
  return res.text();
}

async function readCache(dir: string): Promise<CacheFile | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, CACHE_FILE), "utf8")) as Partial<CacheFile>;
    if (!isUsableRate(raw.usdPerEur) || typeof raw.date !== "string" || typeof raw.fetchedAt !== "number") return null;
    return { usdPerEur: raw.usdPerEur, date: raw.date, fetchedAt: raw.fetchedAt };
  } catch {
    return null;
  }
}

/** The rate to show now. Never throws. */
export async function loadFxRate(deps: FxDeps): Promise<MoneyRate> {
  const override = Number(process.env.CODARA_FX_RATE);
  if (isUsableRate(override)) return { usdPerEur: override, date: "override", source: "cache" };
  const now = (deps.now ?? Date.now)();
  const cached = await readCache(deps.dir);
  const fromCache = (): MoneyRate =>
    cached ? { usdPerEur: cached.usdPerEur, date: cached.date, source: "cache" } : BUILT_IN_RATE;
  // fetchedAt in the future (clock moved back) counts as stale.
  if (cached && now >= cached.fetchedAt && now - cached.fetchedAt < DAY_MS) return fromCache();
  try {
    const parsed = parseEcbDaily(await (deps.fetchText ?? defaultFetchText)(ECB_DAILY_URL));
    if (!parsed) return fromCache();
    await writeFileAtomic(join(deps.dir, CACHE_FILE), JSON.stringify({ usdPerEur: parsed.usdPerEur, date: parsed.date, fetchedAt: now }, null, 2)).catch(() => {});
    return parsed;
  } catch {
    return fromCache();
  }
}

const RETRY_MS = 60 * 60 * 1000;
let inflight: Promise<MoneyRate> | null = null;
let last: { rate: MoneyRate; at: number } | null = null;

/** Loads the rate and makes it the main process's own (for the cap messages).
 *  An offline machine retries once an hour, not on every page open. */
export function refreshFxRate(dir: string): Promise<MoneyRate> {
  if (last && Date.now() - last.at < RETRY_MS) return Promise.resolve(last.rate);
  inflight ??= loadFxRate({ dir })
    .then((rate) => {
      setMoneyRate(rate);
      last = { rate, at: Date.now() };
      return rate;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
