interface Props {
  used: number;
  /** Cora's configured policy target (256k by default). */
  budget: number;
  /** Earlier provider-safe ceiling when the selected model cannot reach the
   * policy target. Progress follows this value; the label keeps the stable
   * Cora target so model internals do not masquerade as product policy. */
  effectiveBudget?: number;
}

export default function ContextPill({ used, budget, effectiveBudget = budget }: Props) {
  const safeBudget = effectiveBudget > 0 ? effectiveBudget : budget;
  const pct = safeBudget > 0 ? Math.min(1, used / safeBudget) : 0;
  const modelCompactsEarlier = safeBudget > 0 && safeBudget < budget;
  const title = modelCompactsEarlier
    ? `${formatTokens(used)} used · Cora targets ${formatTokens(budget)} · this model compacts around ${formatTokens(safeBudget)} to preserve safety room`
    : `${formatTokens(used)} / ${formatTokens(budget)} tokens before Cora compacts the chat`;
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
