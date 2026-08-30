import React, { useEffect, useRef, useState } from "react";
import AnchoredMenu from "./chat/composer/AnchoredMenu";

/**
 * The pieces every account card is built from, shared by the one card shape
 * (AccountCard) and the Add-account picker (AccountCards). Nothing here
 * knows which provider it is drawing for.
 */

export const INPUT_STYLE: React.CSSProperties = {
  minWidth: 0,
  width: "100%",
  height: 30,
  borderRadius: "var(--radius-control, 5px)",
  border: "1px solid var(--rule-strong)",
  background: "color-mix(in oklab, var(--bg) 68%, transparent)",
  color: "var(--ink)",
  padding: "0 9px",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  outline: "none",
};

export const BUTTON_STYLE: React.CSSProperties = {
  minHeight: 27,
  borderRadius: "var(--radius-control, 5px)",
  border: "1px solid var(--rule-strong)",
  background: "color-mix(in oklab, var(--ink) 4%, transparent)",
  color: "var(--ink)",
  padding: "4px 8px",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};

export const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_STYLE,
  border: "1px solid var(--accent-edge)",
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
};

/**
 * Card-scale controls. A column of account cards is the dense part of this
 * panel, so the buttons inside a card (the next step and the "···" trigger)
 * run one step below the form-scale buttons the Add-account row and the
 * rename forms use. `height` has to be set and not just `minHeight`:
 * .spark-btn pins its own 26px, which a smaller minimum alone cannot undo.
 */
export const COMPACT_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_STYLE,
  height: 21,
  minHeight: 21,
  padding: "0 7px",
  fontSize: 10.5,
};

export const COMPACT_PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  ...COMPACT_BUTTON_STYLE,
  border: "1px solid var(--accent-edge)",
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
};

/**
 * One entry in a card's action model. `run` may return false to keep the
 * overflow menu open, which is how Delete keeps its two-step arming inside
 * the menu instead of firing on the first click.
 */
export interface CardAction {
  id: string;
  label: string;
  disabled: boolean;
  danger?: boolean;
  run: () => void | boolean;
}

export interface ConnectionState {
  ok: boolean;
  text: string;
  danger?: boolean;
}

export function ActionButton({
  children,
  disabled,
  primary = false,
  compact = false,
  tone,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  primary?: boolean;
  /** Card-scale rather than form-scale, see COMPACT_BUTTON_STYLE. */
  compact?: boolean;
  /** Agent brand colour; when set, the button follows the family instead of the workspace accent. */
  tone?: string;
  onClick: () => void;
}) {
  const base = compact
    ? primary
      ? COMPACT_PRIMARY_BUTTON_STYLE
      : COMPACT_BUTTON_STYLE
    : primary
      ? PRIMARY_BUTTON_STYLE
      : BUTTON_STYLE;
  const tinted = tone
    ? {
        ...base,
        ...(primary
          ? {
              border: `1px solid color-mix(in oklch, ${tone} 40%, transparent)`,
              background: `color-mix(in oklch, ${tone} 16%, transparent)`,
              color: tone,
            }
          : {}),
      }
    : base;
  return (
    <button
      type="button"
      className="spark-btn"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...tinted,
        ...(disabled ? { cursor: "default", opacity: 0.5 } : {}),
      }}
    >
      {children}
    </button>
  );
}

export function UsingChip({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        color,
        border: `1px solid color-mix(in oklch, ${color} 55%, transparent)`,
        background: `color-mix(in oklch, ${color} 18%, var(--panel-2))`,
        borderRadius: 99,
        padding: "2px 8px",
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 650,
        lineHeight: 1.3,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/**
 * Why these menus portal (AnchoredMenu) instead of hanging position:absolute
 * off their trigger: the Accounts panel lives inside the Settings dialog's
 * scrolling content pane, and `overflow: auto` clips everything in its
 * subtree. A card's right-aligned menu reaches left of its narrow trigger, so
 * the clipped half painted nothing and its clicks fell through to the nav
 * column beside the pane, menu items that plain did not work. Portalling to
 * <body> also moves the menu out from under .settings-dialog-surface, whose
 * backdrop-filter + contain:paint make it a backdrop root: in there .spark-menu
 * is swapped to a preblended 78%-alpha face (styles.css), which over dense
 * card text read as a ghost box. At <body> the menu is real glass again,
 * frosting the dialog beneath it exactly as the composer menus do. z 120
 * clears the dialog wrapper's z 100.
 */
export const SETTINGS_MENU_Z = 120;

/**
 * The card's "···" menu, on the same shared .spark-menu surface the
 * Add-account chooser uses. Groups render with a hairline between them, which
 * is how the destructive block (Sign out, Delete) stays at the bottom and
 * apart. Closing the menu in any way tells the caller, so a half-armed Delete
 * disarms rather than surviving to the next open.
 */
export function CardOverflowMenu({
  label,
  groups,
  onClose,
}: {
  label: string;
  groups: ReadonlyArray<ReadonlyArray<CardAction>>;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    onClose();
  };

  const visibleGroups = groups.filter((group) => group.length > 0);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="spark-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? close() : setOpen(true))}
        style={{ ...COMPACT_BUTTON_STYLE, padding: "0 8px", letterSpacing: 1 }}
      >
        ···
      </button>
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        className="spark-menu"
        role="menu"
        ariaLabel={label}
        placement="below"
        align="end"
        zIndex={SETTINGS_MENU_Z}
      >
        <div style={{ minWidth: 208, display: "grid", gap: 2 }}>
          {visibleGroups.map((group, groupIndex) => (
            <React.Fragment key={groupIndex}>
              {groupIndex > 0 ? (
                <div
                  aria-hidden
                  style={{ borderTop: "1px solid var(--rule-soft)", margin: "2px 0" }}
                />
              ) : null}
              {group.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  className="spark-menu-item"
                  disabled={action.disabled}
                  onClick={() => {
                    // A false return means the item changed state (armed a
                    // delete) and wants a second look before the menu goes.
                    if (action.run() === false) return;
                    close();
                  }}
                  style={{
                    textAlign: "left",
                    whiteSpace: "nowrap",
                    ...(action.danger ? { color: "var(--danger)" } : {}),
                  }}
                >
                  {action.label}
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>
      </AnchoredMenu>
    </>
  );
}

/**
 * One sign-in's state, as an inline mark-plus-sentence pair rather than a row
 * of its own. A long state ("...is not installed on this Mac", an error)
 * wraps to its own line and stays readable at full length. The wording is
 * what tells states apart, so it is never shortened here.
 */
export function ConnectionLine({ state }: { state: ConnectionState }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        minWidth: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          color: state.ok
            ? "var(--accent)"
            : state.danger
              ? "var(--danger)"
              : "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          lineHeight: 1.35,
        }}
      >
        {state.ok ? "✓" : "·"}
      </span>
      <span
        style={{
          minWidth: 0,
          color: state.danger
            ? "var(--danger)"
            : state.ok
              ? "var(--ink)"
              : "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          lineHeight: 1.35,
        }}
      >
        {state.text}
      </span>
    </span>
  );
}

export function RenameForm({
  ariaLabel,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  ariaLabel: string;
  initial: string;
  busy: boolean;
  onSave: (label: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial);

  useEffect(() => {
    setLabel(initial);
  }, [initial]);

  return (
    <form
      aria-label={ariaLabel}
      onSubmit={(event) => {
        event.preventDefault();
        const next = label.trim();
        if (!next || busy) return;
        void onSave(next);
      }}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto auto",
        gap: 6,
      }}
    >
      <input
        aria-label="Account name"
        autoFocus
        className="spark-input"
        value={label}
        maxLength={80}
        onChange={(event) => setLabel(event.currentTarget.value)}
        style={INPUT_STYLE}
      />
      <button
        type="submit"
        className="spark-btn is-primary"
        disabled={!label.trim() || busy}
      >
        {busy ? "Saving…" : "Save"}
      </button>
      <ActionButton disabled={busy} onClick={onCancel}>
        Cancel
      </ActionButton>
    </form>
  );
}
