import { contextMeterRatio } from "./context-meter";

interface Props {
  used: number;
  /** Cora's configured policy target (256k by default). */
  budget: number;
}

export default function ContextPill({ used, budget }: Props) {
  // The bar and its label are one gauge, so they must use the same denominator.
  // 97k/256k is ~38%; dividing the bar by a hidden provider fallback made it
  // appear almost full while the adjacent numbers said otherwise.
  const pct = contextMeterRatio(used, budget);
  const title = `${formatTokens(used)} / ${formatTokens(budget)} tokens before Cora compacts the chat`;
  return (
    <div
      className="composer-context"
      title={title}
      aria-label={title}
    >
      <div className="composer-context-bar">
        <div style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="composer-context-label">
        {formatTokens(used)}/{formatTokens(budget)}
      </span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trimDecimal(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimDecimal(n / 1_000)}k`;
  return String(n);
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
