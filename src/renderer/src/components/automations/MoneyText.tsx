import React from "react";
import { MONEY_USD_PART, rateNote } from "@shared/money";

/** Text that may hold "≈€1.72 ($2.00)" amounts (see fmtCost). The euros stay as
 *  they are; the bracketed dollars drop to small, muted print, and the rate that
 *  made the conversion is the tooltip. Re-created on every render so a rate that
 *  arrives late (useMoneyRate) is picked up. */
export function MoneyText({ text }: { text: string }): React.ReactElement {
  const parts: React.ReactNode[] = [];
  let at = 0;
  let found = false;
  for (const m of text.matchAll(MONEY_USD_PART)) {
    found = true;
    const start = m.index ?? 0;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <small key={start} className="automation-money-usd" title={rateNote()}>
        {m[0].slice(1, -1)}
      </small>,
    );
    at = start + m[0].length;
  }
  if (!found) return <>{text}</>;
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
