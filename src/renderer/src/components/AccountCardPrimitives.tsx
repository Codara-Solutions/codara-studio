import React, { useEffect, useRef, useState } from "react";
import AnchoredMenu from "./chat/composer/AnchoredMenu";

/**
 * The pieces every account row is built from, shared by the one row shape
 * (AccountCard) and the Add-account picker (AccountCards). Nothing here
 * knows which provider it is drawing for. The look lives in styles.css
 * under `.st-acct*`, next to the rest of the Settings styles.
 */

export const INPUT_STYLE: React.CSSProperties = {
  minWidth: 0,
  width: "100%",
};

/**
 * One entry in a row's action model. `run` may return false to keep the
 * overflow menu open, which is how Delete keeps its two-step arming inside
 * the menu instead of firing on the first click.
 */
export interface CardAction {
  id: string;
  label: string;
  /** What the button does in full, when the label names only the outcome. */
  title?: string;
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
  quiet = false,
  title,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
  /** The one committing action in a cluster. */
  primary?: boolean;
  /** Borderless, for secondary actions beside a primary one. */
  quiet?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`spark-btn st-acct-btn${primary ? " is-primary" : ""}${quiet ? " st-btn-quiet" : ""}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The marker on the account Cora and the terminal tool are using right now. */
export function ActiveBadge({ label }: { label: string }) {
  return (
    <span className="st-acct-active">
      <svg
        aria-hidden
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12.5l4.5 4.5L19 7" />
      </svg>
      {label}
    </span>
  );
}

/**
 * Why these menus portal (AnchoredMenu) instead of hanging position:absolute
 * off their trigger: the Accounts panel lives inside the Settings dialog's
 * scrolling content pane, and `overflow: auto` clips everything in its
 * subtree. A row's right-aligned menu reaches left of its narrow trigger, so
 * the clipped half painted nothing and its clicks fell through to the nav
 * column beside the pane, menu items that plain did not work. Portalling to
 * <body> also keeps the menu a top-level surface with its own material.
 * z 120 clears the dialog wrapper's z 100.
 */
export const SETTINGS_MENU_Z = 120;

/**
 * The row's overflow menu, on the same shared .spark-menu surface the
 * Add-account chooser uses. Groups render with a hairline between them, which
 * is how the destructive block (Delete) stays at the bottom and apart.
 * Closing the menu in any way tells the caller, so a half-armed Delete
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
        className={`spark-icon-btn st-icon-btn${open ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title="More actions"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="6" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="18" cy="12" r="1.6" />
        </svg>
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
        <div className="st-acct-menu">
          {visibleGroups.map((group, groupIndex) => (
            <React.Fragment key={groupIndex}>
              {groupIndex > 0 ? <div aria-hidden className="st-acct-menu__rule" /> : null}
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
                  style={action.danger ? { color: "var(--danger)" } : undefined}
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
 * One sign-in's state as a mark and a sentence. A long state (an error)
 * wraps and stays readable at full length; a caller that shortens it passes
 * the full sentence as `title`. `action` puts the fix right beside the
 * problem instead of in the overflow menu.
 */
export function ConnectionLine({
  state,
  title,
  hint,
  code,
  action,
}: {
  state: ConnectionState;
  /** The full sentence, as a tooltip, when the line shows a shortened one. */
  title?: string;
  /** A second, quieter sentence that says what to do. */
  hint?: string;
  /** A command named in the sentences, drawn as code wherever it appears. */
  code?: string;
  action?: React.ReactNode;
}) {
  // A problem is a warning glyph on a quiet line, not red text: the row's
  // button is where the eye should land.
  const tone = state.danger ? "warn" : state.ok ? "ok" : "muted";
  return (
    <div className={`st-acct-status st-acct-status--${tone}`} title={title}>
      <svg
        aria-hidden
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="st-acct-status__glyph"
      >
        {state.danger ? (
          <>
            <path d="M12 4.5 21 19.5H3z" />
            <line x1="12" y1="10" x2="12" y2="14" />
            <circle cx="12" cy="16.9" r="0.4" fill="currentColor" />
          </>
        ) : state.ok ? (
          <path d="M5 12.5l4.5 4.5L19 7" />
        ) : (
          <>
            <circle cx="12" cy="12" r="8.5" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <circle cx="12" cy="8" r="0.4" fill="currentColor" />
          </>
        )}
      </svg>
      <span className="st-acct-status__text">
        {withCode(state.text, code)}
        {hint ? <span className="st-acct-status__hint"> {withCode(hint, code)}</span> : null}
      </span>
      {action ? <span className="st-acct-status__action">{action}</span> : null}
    </div>
  );
}

function withCode(text: string, code: string | undefined): React.ReactNode {
  if (!code || !text.includes(code)) return text;
  return text.split(code).flatMap((part, index) =>
    index === 0
      ? [part]
      : [<code key={index} className="st-code">{code}</code>, part],
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
      className="st-input-group"
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
