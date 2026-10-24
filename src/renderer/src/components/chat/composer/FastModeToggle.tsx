import { FAST_MODE_COST_NOTE } from "@shared/fast-mode";

interface Props {
  enabled: boolean;
  onToggle: () => void;
  /** Set when the chat's model cannot run fast; the button then explains why. */
  unavailableReason?: string;
}

// The composer's fast-mode control. Fast mode is one global setting that the
// manager and every worker it launches read, so the button stays clickable
// while it is on even for a model without fast mode: that model runs at
// standard speed, but the user must still be able to turn the setting off for
// the workers. Off on such a model, it is disabled and says why.
function fastModeToggleTitle(enabled: boolean, unavailableReason?: string): string {
  if (unavailableReason) {
    return enabled
      ? `Fast mode is on for workers on supported models. ${unavailableReason} Click to turn it off.`
      : `Fast mode unavailable. ${unavailableReason}`;
  }
  return enabled
    ? `Fast mode on for Cora and her workers. ${FAST_MODE_COST_NOTE}`
    : `Fast mode off. ${FAST_MODE_COST_NOTE}`;
}

export default function FastModeToggle({ enabled, onToggle, unavailableReason }: Props) {
  const title = fastModeToggleTitle(enabled, unavailableReason);
  const disabled = Boolean(unavailableReason) && !enabled;
  return (
    <button
      type="button"
      className={`composer-fast${enabled ? " is-on" : ""}${unavailableReason ? " is-unavailable" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={enabled}
      disabled={disabled}
      onClick={onToggle}
    >
      <FlashGlyph filled={enabled} />
    </button>
  );
}

function FlashGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width={13} height={13} viewBox="0 0 12 12" aria-hidden style={{ flex: "0 0 auto" }}>
      <path
        d="M6.9 1 2.6 6.6h2.6L5.1 11l4.3-5.6H6.8L6.9 1Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.1}
        strokeLinejoin="round"
      />
    </svg>
  );
}
