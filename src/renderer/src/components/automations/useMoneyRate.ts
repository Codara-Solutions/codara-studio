import { useEffect, useState } from "react";
import { setMoneyRate, type MoneyRate } from "@shared/money";

/** Asks the main process for the ECB rate once per window and re-renders the
 *  caller when it arrives. Until then the built-in rate is in use. */
let loaded: Promise<MoneyRate | undefined> | null = null;

export function useMoneyRate(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    let live = true;
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
    return () => {
      live = false;
    };
  }, []);
}
