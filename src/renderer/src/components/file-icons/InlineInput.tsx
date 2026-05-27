import { useEffect, useRef, useState } from "react";

type Props = {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
};

/**
 * Self-focusing single-line input for rename / create flows in the tree.
 *
 * - Enter commits, Escape cancels.
 * - Blur commits (matches VSCode behavior - dismissing the input is an implicit
 *   commit so a typed name isn't lost).
 * - Two-tick (raf) focus dance defeats parent click handlers and any portal
 *   restorations that can steal focus right after mount. Until the second tick
 *   lands we treat the input as "unsettled": any blur during that window is
 *   the portal teardown stealing focus, not the user dismissing the input,
 *   so we refocus instead of committing an empty value.
 */
export function InlineInput({ initial, placeholder, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const settledRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focus = () => {
      el.focus({ preventScroll: false });
      // Select the basename portion (everything before the final extension).
      const dot = initial.lastIndexOf(".");
      if (dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    };
    focus();
    const raf = requestAnimationFrame(() => {
      focus();
      settledRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [initial]);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        // Stop tree row click/keyboard handlers from receiving these.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={() => {
        if (!settledRef.current) {
          ref.current?.focus({ preventScroll: true });
          return;
        }
        commit();
      }}
      style={{
        flex: 1,
        minWidth: 0,
        height: 18,
        background: "var(--bg)",
        color: "var(--ink)",
        border: "1px solid var(--accent-edge)",
        borderRadius: 4,
        outline: "none",
        padding: "1px 6px",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
      }}
    />
  );
}
