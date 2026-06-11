import React from "react";

// Small form atoms shared by the Automations editor surfaces (node-flow
// context panel, hub fragments). Moved verbatim out of AutomationsHub so the
// flow/ components can import them without a circular dependency.

export function Field({
  label,
  grow,
  children,
}: {
  label: string;
  grow?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, flex: grow ? 1 : undefined, minWidth: 0 }}>
      <span className="spark-eyebrow">{label}</span>
      {children}
    </label>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  wrap,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  /** Allow items to wrap to multiple rows when they would overflow (e.g. a
   *  5+ option control inside the narrow 360px node panel). */
  wrap?: boolean;
}): React.ReactElement {
  return (
    <div
      className={`spark-segmented${wrap ? " is-wrap" : ""}`}
      role="group"
      style={wrap ? { display: "flex", flexWrap: "wrap" } : undefined}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`spark-segmented-item${o.value === value ? " is-selected" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Check({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: "default",
        fontSize: 11,
        color: checked ? "var(--ink)" : "var(--muted)",
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ accentColor: "var(--accent)", cursor: "default" }} />
      {label}
    </label>
  );
}
