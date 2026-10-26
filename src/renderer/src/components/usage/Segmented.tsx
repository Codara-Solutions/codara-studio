/** The Usage tab's pill switch: a few uppercase options, one pressed. */
export default function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: 2,
        borderRadius: 99,
        border: "1px solid var(--rule)",
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            style={{
              appearance: "none",
              border: "none",
              borderRadius: 99,
              padding: "3px 10px",
              background: selected
                ? "color-mix(in oklab, var(--ink) 9%, transparent)"
                : "transparent",
              color: selected ? "var(--ink)" : "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              cursor: "default",
              transition:
                "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
