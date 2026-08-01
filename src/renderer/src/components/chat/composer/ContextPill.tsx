interface Props {
  used: number;
  budget: number;
  /** True when `budget` is the point this chat auto-compacts at rather than the
   *  model's full window. Explains a denominator smaller than the model's
   *  advertised context, which is otherwise a confusing number to read. */
  compactsAtBudget?: boolean;
}

// Token-budget pill. Tiny progress bar + numeric `used/budget` label. Pure
// presentation — the parent computes both numbers and passes them in.
export default function ContextPill({ used, budget, compactsAtBudget }: Props) {
  const pct = budget > 0 ? Math.min(1, used / budget) : 0;
  return (
    <div
      className="composer-context"
      title={
        compactsAtBudget
          ? `${formatTokens(used)} / ${formatTokens(budget)} tokens used before this chat auto-compacts`
          : `${formatTokens(used)} / ${formatTokens(budget)} tokens used`
      }
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
