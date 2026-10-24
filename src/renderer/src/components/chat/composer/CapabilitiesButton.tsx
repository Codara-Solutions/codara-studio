interface Props {
  onOpen: () => void;
}

// The composer's way into the Capability Center. It carries a visible word,
// not a bare glyph: a first-time user has no reason to guess that two sliders
// mean "MCP servers, skills and memory". The label collapses to the glyph on a
// narrow composer, and the accessible name stays complete either way.
export default function CapabilitiesButton({ onOpen }: Props) {
  return (
    <button
      type="button"
      className="composer-pill composer-tools-trigger"
      onClick={onOpen}
      title="Tools, skills and memory: open the Capability Center"
      aria-label="Tools, skills and memory"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
        <path d="M2.5 4h9M2.5 10h9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        <circle cx="5" cy="4" r="1.4" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="9" cy="10" r="1.4" stroke="currentColor" strokeWidth="1.25" />
      </svg>
      <span className="composer-tools-label">Tools</span>
    </button>
  );
}
