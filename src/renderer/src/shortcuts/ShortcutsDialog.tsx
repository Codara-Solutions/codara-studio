import React, { useEffect, useMemo } from "react";
import { COMMAND_GROUPS } from "./commands";
import { buildBindingTable, type BindingTable } from "./bindings";
import { chordToDisplay } from "./chord";
import { usePreferences } from "../preferences/usePreferences";

// Cheat-sheet rendered off the live command registry, with each chord
// resolved through the user's keybinding overrides so customized chords
// show through. The chrome mirrors SettingsDialog so the two modals feel
// like siblings.

interface ShortcutsDialogProps {
  onClose: () => void;
}

export default function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const { preferences } = usePreferences();
  const table = useMemo<BindingTable>(
    () => buildBindingTable(preferences.keybindings),
    [preferences.keybindings],
  );
  const groups = useMemo(
    () =>
      COMMAND_GROUPS.map((group) => ({
        group,
        // A cheat sheet only shows shortcuts that can actually be pressed.
        // Unbound commands stay available in Settings → Keybindings.
        items: table.filter(
          (binding) => binding.command.group === group && binding.chords.length > 0,
        ),
      })).filter((entry) => entry.items.length > 0),
    [table],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-sans)",
      }}
      onMouseDown={onClose}
    >
      <div className="spark-scrim spark-scrim--clear" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="spark-glass--strong spark-overlay-surface"
        style={{
          zIndex: 1,
          width: "min(720px, calc(100vw - 44px))",
          maxHeight: "min(620px, calc(100vh - 44px))",
          display: "flex",
          flexDirection: "column",
          borderRadius: 12,
          overflow: "hidden",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header
          style={{
            flex: "0 0 auto",
            padding: "13px 18px",
            borderBottom: "1px solid var(--rule-soft)",
            display: "flex",
            alignItems: "center",
            gap: 9,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
              Keyboard shortcuts
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              Active shortcuts only · customize them in Settings
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              appearance: "none",
              border: "1px solid var(--rule-soft)",
              borderRadius: 6,
              background: "transparent",
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              padding: "3px 8px",
              cursor: "default",
              transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
            }}
          >
            ESC
          </button>
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: "14px 18px 18px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            alignItems: "start",
            gap: 12,
          }}
        >
          {groups.map(({ group, items }) => {
            return (
              <section
                key={group}
                style={{
                  overflow: "hidden",
                  border: "1px solid var(--rule-soft)",
                  borderRadius: 9,
                  background: "color-mix(in oklab, var(--panel) 62%, transparent)",
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--rule-soft)",
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--ink-dim)",
                  }}
                >
                  {group}
                </h3>
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {items.map((b, index) => {
                    // We display the first chord in the list so the cheat
                    // sheet stays uncluttered (zoom-in defaults to two
                    // shift-equivalent chords — showing both would be
                    // redundant). "Switch tab 1–9" gets a special label
                    // because the chord shape is a range.
                    const chips =
                      b.command.id === "view.selectByIndex"
                        ? [...chordToDisplay(b.chords[0]).slice(0, -1), "1…9"]
                        : chordToDisplay(b.chords[0]);
                    return (
                      <li
                        key={b.command.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          padding: "7px 10px",
                          borderTop: index === 0 ? "none" : "1px solid var(--rule-soft)",
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--font-sans)",
                            fontSize: 11.5,
                            color: "var(--ink)",
                          }}
                        >
                          {b.command.label}
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {chips.map((k, i) => (
                            <Kbd key={i}>{k}</Kbd>
                          ))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 22,
        height: 22,
        padding: "0 6px",
        border: "1px solid var(--rule-strong)",
        borderRadius: 5,
        background: "var(--panel-3)",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        boxShadow: "var(--lift-hi), var(--well)",
      }}
    >
      {children}
    </kbd>
  );
}
