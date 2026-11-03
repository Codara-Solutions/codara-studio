import { useEffect, useState } from "react";
import { setMoneyRate, type MoneyRate } from "@shared/money";

/** Asks the main process for the ECB rate once per window and re-renders the
 *  caller when it arrives. Until then the built-in rate is in use. */
// A window can stay open for days, so the answer is asked for again after a while
// (the main process only goes to the ECB once a day, and an offline start retries).
const REFRESH_MS = 3 * 60 * 60 * 1000;
let loaded: Promise<MoneyRate | undefined> | null = null;
let loadedAt = 0;

export function useMoneyRate(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    let live = true;
    const ask = (): void => {
      if (loaded && Date.now() - loadedAt > REFRESH_MS) loaded = null;
      if (!loaded) loadedAt = Date.now();
      const pending = (loaded ??= window.spark.money
        .rate()
        .then((rate: MoneyRate) => {
          setMoneyRate(rate);
          return rate;
        })
        .catch(() => undefined));
      void pending.then((rate) => {
        if (live && rate) bump((n) => n + 1);
      });
    };
    ask();
    // The page stays mounted for days; the main process answers from its cache.
    const timer = window.setInterval(ask, REFRESH_MS / 3);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
}
