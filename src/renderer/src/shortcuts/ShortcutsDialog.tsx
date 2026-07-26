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
  open: boolean;
  onClose: () => void;
}

export default function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const { preferences } = usePreferences();
  const table = useMemo<BindingTable>(
    () => buildBindingTable(preferences.keybindings),
    [preferences.keybindings],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in oklab, var(--bg) 58%, transparent)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        fontFamily: "var(--font-sans)",
      }}
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        style={{
          width: "min(540px, calc(100vw - 44px))",
          maxHeight: "min(640px, calc(100vh - 44px))",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--rule-soft)",
          borderRadius: 12,
          boxShadow: "var(--shadow-2)",
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
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "var(--accent)",
              boxShadow: "0 0 9px var(--accent-glow)",
            }}
          />
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.02em",
              color: "var(--ink)",
            }}
          >
            Keyboard shortcuts
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
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          {COMMAND_GROUPS.map((group) => {
            const items = table.filter((b) => b.command.group === group);
            if (items.length === 0) return null;
            return (
              <section key={group} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <h3
                  style={{
                    margin: 0,
                    fontFamily: "var(--font-sans)",
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    color: "var(--muted)",
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
                  {items.map((b) => {
                    // We display the first chord in the list so the cheat
                    // sheet stays uncluttered (zoom-in defaults to two
                    // shift-equivalent chords — showing both would be
                    // redundant). "Switch tab 1–9" gets a special label
                    // because the chord shape is a range.
                    const chips =
                      b.command.id === "view.selectByIndex"
                        ? [...chordToDisplay(b.chords[0]).slice(0, -1), "1…9"]
                        : b.chords.length > 0
                          ? chordToDisplay(b.chords[0])
                          : ["—"];
                    return (
                      <li
                        key={b.command.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          padding: "8px 0",
                          borderBottom: "1px solid var(--rule-soft)",
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--font-sans)",
                            fontSize: 12,
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
