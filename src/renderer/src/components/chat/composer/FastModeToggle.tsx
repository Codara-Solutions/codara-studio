interface Props {
  enabled: boolean;
  onToggle: () => void;
}

// The composer's fast-mode control. It is rendered only for an OpenAI model
// (ChatComposer gates on chatModelIsOpenAi), because fast mode buys OpenAI's
// priority service tier and Anthropic has no such thing — an Anthropic chat
// must never show, let alone offer, this button.
export default function FastModeToggle({ enabled, onToggle }: Props) {
  const title = enabled
    ? "Fast mode on — OpenAI responses use the faster tier"
    : "Fast mode off";
  return (
    <button
      type="button"
      className={`composer-fast${enabled ? " is-on" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={enabled}
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
