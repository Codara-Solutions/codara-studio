import React, { useEffect, useRef, useState } from "react";
import type { PiSubscriptionProvider } from "@shared/types";
import AnchoredMenu from "./chat/composer/AnchoredMenu";

export type NativeCliAccountRuntime = "claude" | "codex";

export type NativeCliAccountAuthState =
  | "connected"
  | "signed-out"
  | "expired"
  | "checking"
  | "unavailable"
  | "error";

export type NativeCliAccountBusyAction =
  | "checking"
  | "creating"
  | "renaming"
  | "setting-default"
  | "signing-in"
  | "signing-out"
  | "deleting";

/**
 * One account card can carry two sign-ins: the one Cora uses and the one the
 * command-line tool uses. They are merged into a single card when the main
 * process reports the same anonymous account fingerprint for both — see the
 * pairing note in SettingsDialog. Ids on both facets are opaque routing values;
 * this component only hands them back through callbacks and never renders them.
 * The two sign-ins stay stored apart, so each facet keeps its own active state
 * and its own actions.
 */
export interface AccountCoraFacet {
  profileId: string;
  connected: boolean;
  expired: boolean;
  active: boolean;
  busy: boolean;
  error?: string;
}

export interface AccountCliFacet {
  profileId: string;
  runtime: NativeCliAccountRuntime;
  authState: NativeCliAccountAuthState;
  active: boolean;
  inUse: boolean;
  managed: boolean;
  busyAction?: NativeCliAccountBusyAction | null;
}

export interface AccountCardView {
  key: string;
  label: string;
  provider: PiSubscriptionProvider;
  /**
   * The account's email address, shown under the name so two accounts with
   * similar names are still tellable apart. Absent when neither side of the
   * card could report one.
   */
  email?: string;
  /** Plan name for the Cora connection, e.g. "Max". */
  plan?: string;
  cora?: AccountCoraFacet;
  cli?: AccountCliFacet;
  /**
   * Set on a Cora-only card that sits beside an unmatched command-line sign-in,
   * where reconnecting is what would let Codara tell they are one account.
   */
  pairHint?: string;
  /** Usage limits for this account, rendered inside the card body. */
  usage?: React.ReactNode;
}

export interface AccountProviderView {
  provider: PiSubscriptionProvider;
  /** Human provider name, e.g. "Anthropic". */
  label: string;
  /** Human name of the local tool, e.g. "Claude Code". */
  cliLabel: string;
  /** Short plain-language summary shown under the provider name. */
  detail: string;
  cards: AccountCardView[];
  /** Cora actions are unavailable until the Pi runtime is installed. */
  coraDisabled: boolean;
  /** A Cora browser login or account mutation is in flight. */
  coraBusy: boolean;
  cliDisabled: boolean;
  cliLoading: boolean;
  cliError: boolean;
  /** The CLI reports no built-in account, so its status cannot be shown. */
  cliPersonalMissing: boolean;
  addingCora: boolean;
  addCoraLabel: string;
  addingCli: boolean;
  addCliLabel: string;
}

/**
 * One "Add account" button per provider opens this chooser. Both options were
 * side-by-side buttons before, which asked the reader to know what "for Cora"
 * meant; each one now says what it signs in and what that sign-in is used for.
 * Each option runs the same flow its button used to run.
 */
interface AddAccountChoice {
  id: "cora" | "cli";
  title: string;
  detail: string;
  disabled: boolean;
  onChoose: () => void;
}

export interface AccountActions {
  /** Connect a card that only has a CLI sign-in to Cora (same login flow as
   *  "Add account → Connect to Cora", seeded with the card's name). */
  onCoraConnect: (card: AccountCardView) => void;
  onBeginAddCora: (provider: PiSubscriptionProvider) => void;
  onAddCoraLabel: (label: string) => void;
  onAddCora: (provider: PiSubscriptionProvider) => void;
  onCancelAddCora: () => void;
  onBeginAddCli: (provider: PiSubscriptionProvider) => void;
  onAddCliLabel: (label: string) => void;
  onAddCli: (provider: PiSubscriptionProvider) => void;
  onCancelAddCli: () => void;
  onCoraReconnect: (card: AccountCardView) => void;
  onCoraRename: (card: AccountCardView, label: string) => Promise<boolean>;
  onCoraUse: (card: AccountCardView) => void;
  onCoraDelete: (card: AccountCardView) => void;
  onCliSignIn: (card: AccountCardView) => void;
  onCliSignOut: (card: AccountCardView) => void;
  onCliRename: (card: AccountCardView, label: string) => Promise<boolean>;
  onCliUse: (card: AccountCardView) => void;
  onCliDelete: (card: AccountCardView) => void;
}

const INPUT_STYLE: React.CSSProperties = {
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

const BUTTON_STYLE: React.CSSProperties = {
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

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_STYLE,
  border: "1px solid var(--accent-edge)",
  background: "var(--accent-soft)",
  color: "var(--accent)",
};

/**
 * Card-scale controls. A column of account cards is the dense part of this
 * panel, so the buttons inside a card — the ≤2 next steps and the "···"
 * trigger — run one step below the form-scale buttons the Add-account row and
 * the rename forms use. `height` has to be set and not just `minHeight`:
 * .spark-btn pins its own 26px, which a smaller minimum alone cannot undo.
 */
const COMPACT_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_STYLE,
  height: 21,
  minHeight: 21,
  padding: "0 7px",
  fontSize: 10.5,
};

const COMPACT_PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  ...COMPACT_BUTTON_STYLE,
  border: "1px solid var(--accent-edge)",
  background: "var(--accent-soft)",
  color: "var(--accent)",
};

/**
 * Action diet: a card shows at most two buttons — the single most useful next
 * step first (accent), one runner-up beside it — and everything else waits
 * behind the "···" menu. A state that is already true never gets a button, so
 * a fully connected active card shows no buttons at all: its state is the
 * point.
 */
const MAX_VISIBLE_CARD_ACTIONS = 2;

/**
 * One entry in the card's action model. `run` may return false to keep the
 * overflow menu open — that is how Delete keeps its two-step arming inside
 * the menu instead of firing on the first click.
 */
interface CardAction {
  id: string;
  label: string;
  disabled: boolean;
  danger?: boolean;
  run: () => void | boolean;
}

/**
 * Shown instead of usage bars on a card that is only signed in to the
 * command-line tool. Limits come from the account's own Cora connection, and a
 * terminal sign-in's credential is never used to ask for them.
 */
export const CLI_ONLY_USAGE_HINT =
  "Usage limits show once this account is connected to Cora — they cover everything the account does, including the terminal.";

/**
 * Said before the user runs into it, not after. A managed account directory is
 * created already past the CLI's first-run wizard, so the terminal opens
 * straight into a working prompt — with no sign-in behind it until this account
 * has been signed in once, and the terminal cannot be switched to it before
 * then. "Sign in to <tool>" leads the action ladder in exactly this state, so
 * the hint points at a button that is always visible when it is shown.
 */
export function cliSignInHint(
  facet: AccountCliFacet | undefined,
  cliLabel: string,
): string | null {
  if (!facet || facet.busyAction || facet.authState !== "signed-out") return null;
  return `This account isn't signed in to ${cliLabel} yet — use "Sign in to ${cliLabel}" below, or run ${facet.runtime} in a terminal once.`;
}

function busyLabel(action: NativeCliAccountBusyAction): string {
  switch (action) {
    case "checking":
      return "Checking…";
    case "creating":
      return "Adding…";
    case "renaming":
      return "Saving…";
    case "setting-default":
      return "Switching account…";
    case "signing-in":
      return "Opening sign-in…";
    case "signing-out":
      return "Signing out…";
    case "deleting":
      return "Deleting…";
  }
}

interface ConnectionState {
  ok: boolean;
  text: string;
  danger?: boolean;
}

function coraConnectionState(facet: AccountCoraFacet | undefined): ConnectionState {
  if (!facet) return { ok: false, text: "Not connected to Cora" };
  if (facet.error) return { ok: false, text: facet.error, danger: true };
  if (!facet.connected) return { ok: false, text: "Not connected to Cora" };
  if (facet.expired) {
    return {
      ok: false,
      text: "Connected to Cora, but the sign-in expired",
      danger: true,
    };
  }
  return { ok: true, text: "Connected to Cora" };
}

function cliConnectionState(
  facet: AccountCliFacet | undefined,
  cliLabel: string,
): ConnectionState {
  if (!facet) return { ok: false, text: `Not signed in to ${cliLabel}` };
  if (facet.busyAction) return { ok: false, text: busyLabel(facet.busyAction) };
  switch (facet.authState) {
    case "connected":
      return {
        ok: true,
        text: `Signed in to ${cliLabel}${facet.inUse ? ", in use right now" : ""}`,
      };
    case "signed-out":
      return { ok: false, text: `Not signed in to ${cliLabel}` };
    case "expired":
      return {
        ok: false,
        text: `Signed in to ${cliLabel}, but the sign-in expired`,
        danger: true,
      };
    case "checking":
      return { ok: false, text: `Checking the ${cliLabel} sign-in…` };
    case "unavailable":
      return { ok: false, text: `${cliLabel} is not installed on this Mac` };
    case "error":
      return { ok: false, text: `The ${cliLabel} sign-in needs attention`, danger: true };
  }
}

function ActionButton({
  children,
  disabled,
  primary = false,
  compact = false,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  primary?: boolean;
  /** Card-scale rather than form-scale — see COMPACT_BUTTON_STYLE. */
  compact?: boolean;
  onClick: () => void;
}) {
  const base = compact
    ? primary
      ? COMPACT_PRIMARY_BUTTON_STYLE
      : COMPACT_BUTTON_STYLE
    : primary
      ? PRIMARY_BUTTON_STYLE
      : BUTTON_STYLE;
  return (
    <button
      type="button"
      className="spark-btn"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...base,
        ...(disabled ? { cursor: "default", opacity: 0.5 } : {}),
      }}
    >
      {children}
    </button>
  );
}

/**
 * Why these menus portal (AnchoredMenu) instead of hanging position:absolute
 * off their trigger: the Accounts panel lives inside the Settings dialog's
 * scrolling content pane, and `overflow: auto` clips everything in its
 * subtree. A card's right-aligned menu reaches left of its narrow trigger, so
 * the clipped half painted nothing and its clicks fell through to the nav
 * column beside the pane — menu items that plain did not work. Portalling to
 * <body> also moves the menu out from under .settings-dialog-surface, whose
 * backdrop-filter + contain:paint make it a backdrop root: in there .spark-menu
 * is swapped to a preblended 78%-alpha face (styles.css), which over dense
 * card text read as a ghost box. At <body> the menu is real glass again,
 * frosting the dialog beneath it exactly as the composer menus do. z 120
 * clears the dialog wrapper's z 100.
 */
const SETTINGS_MENU_Z = 120;

/**
 * The card's "···" menu, on the same shared .spark-menu surface the
 * Add-account chooser uses. Groups render with a hairline between them, which
 * is how the destructive block (Sign out, Delete) stays at the bottom and
 * apart. Closing the menu in any way tells the caller, so a half-armed Delete
 * disarms rather than surviving to the next open.
 */
function CardOverflowMenu({
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

function AddAccountMenu({
  label,
  choices,
  disabled,
  primary,
}: {
  label: string;
  choices: ReadonlyArray<AddAccountChoice>;
  disabled: boolean;
  primary: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="spark-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        style={{
          ...(primary ? PRIMARY_BUTTON_STYLE : BUTTON_STYLE),
          ...(disabled ? { cursor: "default", opacity: 0.5 } : {}),
        }}
      >
        Add account
      </button>
      {/* The shared .spark-menu popover surface, portalled for the reasons on
          SETTINGS_MENU_Z above. The item class brings hover/disabled; only the
          two-line grid layout is local. Crucially, the items are NOT
          .spark-btn: that class pins height to 26px, which is what made the
          two-line options overlap each other and the card text behind them. */}
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        className="spark-menu"
        role="menu"
        ariaLabel={label}
        placement="below"
        align="end"
        zIndex={SETTINGS_MENU_Z}
      >
        <div style={{ width: 268, display: "grid", gap: 2 }}>
          {choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="menuitem"
              className="spark-menu-item"
              disabled={choice.disabled}
              onClick={() => {
                setOpen(false);
                choice.onChoose();
              }}
              style={{
                display: "grid",
                gap: 2,
                textAlign: "left",
                padding: "7px 8px",
                height: "auto",
              }}
            >
              <span
                style={{
                  color: "var(--ink)",
                  fontSize: 12,
                  fontWeight: 650,
                }}
              >
                {choice.title}
              </span>
              <span
                style={{
                  color: "var(--muted)",
                  fontSize: 11,
                  fontWeight: 400,
                  lineHeight: 1.4,
                  whiteSpace: "normal",
                }}
              >
                {choice.detail}
              </span>
            </button>
          ))}
        </div>
      </AnchoredMenu>
    </>
  );
}

/**
 * One sign-in's state, as an inline mark-plus-sentence pair rather than a row
 * of its own. The two lines a card carries sit side by side in a wrapping row,
 * so a healthy card spends one line on both — and a long state ("…is not
 * installed on this Mac", an error) still wraps to its own line and stays
 * readable at full length. The wording is what tells the two sides apart, so
 * it is never shortened here.
 */
function ConnectionLine({ state }: { state: ConnectionState }) {
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
        {state.ok ? "✓" : "–"}
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

function AddAccountForm({
  ariaLabel,
  placeholder,
  submitLabel,
  value,
  disabled,
  onValue,
  onSubmit,
  onCancel,
}: {
  ariaLabel: string;
  placeholder: string;
  submitLabel: string;
  value: string;
  disabled: boolean;
  onValue: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      aria-label={ariaLabel}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        onSubmit();
      }}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto auto",
        gap: 6,
      }}
    >
      <input
        aria-label={ariaLabel}
        autoFocus
        className="spark-input"
        value={value}
        maxLength={80}
        placeholder={placeholder}
        onChange={(event) => onValue(event.currentTarget.value)}
        style={INPUT_STYLE}
      />
      <button type="submit" className="spark-btn is-primary" disabled={disabled}>
        {submitLabel}
      </button>
      <ActionButton disabled={disabled} onClick={onCancel}>
        Cancel
      </ActionButton>
    </form>
  );
}

function RenameForm({
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

function AccountCard({
  card,
  cliLabel,
  coraDisabled,
  coraBusy,
  cliDisabled,
  actions,
}: {
  card: AccountCardView;
  cliLabel: string;
  coraDisabled: boolean;
  coraBusy: boolean;
  cliDisabled: boolean;
  actions: AccountActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState<"cora" | "cli" | null>(null);

  const cora = card.cora;
  const cli = card.cli;
  const cliOnly = Boolean(cli && !cora);
  const cliBusy = Boolean(cli?.busyAction);
  const coraFacetBusy = Boolean(cora?.busy);
  // The stored default on each side is the account that side runs on right now
  // — one live login apiece — so the accent edge reads as an active selection.
  // Nothing else in this panel may claim that edge.
  const active = Boolean(cora?.active || cli?.active);
  // The pill always names the side it means — "Active" alone next to "Not
  // connected to Cora" read as a contradiction. Plain "Active" is reserved for
  // a paired card that is the live account on both sides.
  const activeLabel =
    cora && cli && cora.active && cli.active
      ? "Active"
      : cora?.active
        ? "Active in Cora"
        : `Active in ${cliLabel}`;
  const coraControlsDisabled = coraDisabled || coraBusy;
  const cliControlsDisabled =
    cliDisabled || cliBusy || Boolean(cli?.inUse);
  const signInHint = cliSignInHint(cli, cliLabel);

  // The next-step ladder, most useful first. Only entries whose state is NOT
  // already true are built, so the first two are the visible buttons and the
  // first of those is the accent primary; anything past two waits in the "···"
  // menu. A healthy card that is active everywhere builds none of these.
  const nextSteps: CardAction[] = [];
  const cliNeedsSignIn =
    cli &&
    (cli.authState === "signed-out" ||
      cli.authState === "expired" ||
      cli.authState === "error");
  if (cliNeedsSignIn) {
    nextSteps.push({
      id: "cli-sign-in",
      label:
        cli.authState === "signed-out"
          ? `Sign in to ${cliLabel}`
          : `Sign in to ${cliLabel} again`,
      disabled: cliControlsDisabled,
      run: () => actions.onCliSignIn(card),
    });
  }
  if (!cora && cli) {
    // Connect-time fingerprint capture folds the new Cora connection into
    // this card when the identities match.
    nextSteps.push({
      id: "cora-connect",
      label: "Connect to Cora",
      disabled: coraControlsDisabled,
      run: () => actions.onCoraConnect(card),
    });
  }
  if (cora && !cora.connected) {
    nextSteps.push({
      id: "cora-connect",
      label: "Connect to Cora",
      disabled: coraControlsDisabled,
      run: () => actions.onCoraReconnect(card),
    });
  }
  if (cora?.connected && cora.expired) {
    nextSteps.push({
      id: "cora-reconnect",
      label: "Reconnect to Cora",
      disabled: coraControlsDisabled,
      run: () => actions.onCoraReconnect(card),
    });
  }
  // Same stored defaults as before — the wording only says which side is
  // being switched, because a merged card has one per side.
  if (cora?.connected && !cora.expired && !cora.active) {
    nextSteps.push({
      id: "cora-use",
      label: cli ? "Use this account for Cora" : "Use this account",
      disabled: coraControlsDisabled,
      run: () => actions.onCoraUse(card),
    });
  }
  if (cli?.authState === "connected" && !cli.active) {
    nextSteps.push({
      id: "cli-use",
      label: cora ? `Use this account for ${cliLabel}` : "Use this account",
      disabled: cliControlsDisabled,
      run: () => actions.onCliUse(card),
    });
  }
  const visibleActions = nextSteps.slice(0, MAX_VISIBLE_CARD_ACTIONS);

  // Everything else lives in the menu: re-auth for sides that are already
  // signed in, Rename, and — bottom group, behind a hairline — Sign out and
  // Delete. Delete keeps its two-step arming inside the menu.
  const menuActions: CardAction[] = [
    ...nextSteps.slice(MAX_VISIBLE_CARD_ACTIONS),
  ];
  if (cora?.connected && !cora.expired) {
    menuActions.push({
      id: "cora-reconnect",
      label: "Reconnect to Cora",
      disabled: coraControlsDisabled,
      run: () => actions.onCoraReconnect(card),
    });
  }
  if (cli?.authState === "connected") {
    menuActions.push({
      id: "cli-sign-in-again",
      label: `Sign in to ${cliLabel} again`,
      disabled: cliControlsDisabled,
      run: () => actions.onCliSignIn(card),
    });
  }
  // Every card can be named. CLI sign-ins the tool itself cannot rename (the
  // built-in one) get a Codara-side display name via onCliRename, so this
  // affordance never disappears.
  menuActions.push({
    id: "rename",
    label: "Rename",
    disabled: cora ? coraControlsDisabled : cliControlsDisabled,
    run: () => {
      setRenaming(true);
      setDeleteArmed(null);
    },
  });
  const destructiveActions: CardAction[] = [];
  if (cli?.authState === "connected") {
    destructiveActions.push({
      id: "cli-sign-out",
      label: "Sign out",
      disabled: cliControlsDisabled,
      run: () => actions.onCliSignOut(card),
    });
  }
  if (cora) {
    destructiveActions.push({
      id: "cora-delete",
      label:
        deleteArmed === "cora"
          ? "Confirm delete"
          : cli
            ? "Remove from Cora"
            : "Delete",
      danger: true,
      disabled: coraControlsDisabled,
      run: () => {
        if (deleteArmed !== "cora") {
          setDeleteArmed("cora");
          return false;
        }
        setDeleteArmed(null);
        actions.onCoraDelete(card);
      },
    });
  }
  if (cli?.managed) {
    destructiveActions.push({
      id: "cli-delete",
      label:
        deleteArmed === "cli"
          ? "Confirm delete"
          : cora
            ? `Remove the ${cliLabel} account`
            : "Delete",
      danger: true,
      disabled: cliControlsDisabled,
      run: () => {
        if (deleteArmed !== "cli") {
          setDeleteArmed("cli");
          return false;
        }
        setDeleteArmed(null);
        actions.onCliDelete(card);
      },
    });
  }

  return (
    <div
      aria-busy={cliBusy || coraFacetBusy || undefined}
      aria-current={active ? "true" : undefined}
      style={{
        display: "grid",
        gap: 5,
        padding: "7px 9px",
        borderRadius: "var(--radius-control, 5px)",
        border: active ? "1px solid var(--accent-edge)" : "1px solid var(--rule-soft)",
        // Selection, not status: an accent hairline plus a faint ring and a
        // near-transparent wash. A heavier accent fill on a card this large
        // reads as a warning tint, so the pill and border carry the accent.
        background: active
          ? "color-mix(in oklch, var(--accent) 3%, transparent)"
          : "color-mix(in oklab, var(--ink) 3%, transparent)",
        boxShadow: active
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 14%, transparent)"
          : undefined,
      }}
    >
      {/* Name, address, and plan share one line — three stacked lines was the
          card's tallest block and its least informative. Both the name and the
          address can give ground to the other and ellipsize; the plan is two
          words at most, so it holds its width. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            minWidth: 0,
            display: "grid",
            gridAutoFlow: "column",
            // minmax(0, max-content) is load-bearing, not decoration. A flex
            // row of nowrap text reports the sum of that text as the row's own
            // minimum width, so one long address would stop the whole panel
            // from narrowing and hand the Settings scroll pane a horizontal
            // scrollbar. Grid tracks with a zero floor take their content width
            // when it fits and let it ellipsize when it does not.
            gridAutoColumns: "minmax(0, max-content)",
            justifyContent: "start",
            alignItems: "baseline",
            columnGap: 6,
          }}
        >
          <span
            style={{
              minWidth: 0,
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 650,
              lineHeight: 1.35,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {card.label}
          </span>
          {card.email ? (
            <span
              title={card.email}
              style={{
                minWidth: 0,
                color: "var(--muted)",
                fontFamily: "var(--font-sans)",
                fontSize: 10,
                lineHeight: 1.35,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {card.email}
            </span>
          ) : null}
          {card.plan ? (
            <span
              style={{
                minWidth: 0,
                color: "var(--muted)",
                fontFamily: "var(--font-sans)",
                fontSize: 10,
                lineHeight: 1.35,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {card.plan} plan
            </span>
          ) : null}
        </div>
        {/* The card's right edge belongs to state + the overflow menu: the
            Active pill first, then the "···" outermost. The menu lives here —
            not in the action row — so it sits in the same place on every card,
            including one whose action row has nothing to show. */}
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          {active ? (
            <span
              style={{
                color: "var(--accent)",
                border: "1px solid var(--accent-edge)",
                background: "var(--accent-soft)",
                borderRadius: 99,
                padding: "1px 7px",
                fontFamily: "var(--font-sans)",
                fontSize: 9.5,
                fontWeight: 650,
                lineHeight: 1.4,
                whiteSpace: "nowrap",
              }}
            >
              {activeLabel}
            </span>
          ) : null}
          <CardOverflowMenu
            label={`More actions for ${card.label}`}
            groups={[menuActions, destructiveActions]}
            onClose={() => setDeleteArmed(null)}
          />
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          columnGap: 12,
          rowGap: 2,
        }}
      >
        <ConnectionLine state={coraConnectionState(cora)} />
        <ConnectionLine state={cliConnectionState(cli, cliLabel)} />
      </div>

      {signInHint ? (
        <div
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            lineHeight: 1.35,
          }}
        >
          {signInHint}
        </div>
      ) : null}

      {card.pairHint ? (
        <div
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            lineHeight: 1.35,
          }}
        >
          {card.pairHint}
        </div>
      ) : null}

      {card.usage ? (
        <div
          style={{
            display: "grid",
            gap: 5,
            paddingTop: 5,
            borderTop: "1px solid var(--rule-soft)",
          }}
        >
          {card.usage}
        </div>
      ) : cliOnly ? (
        // Limits are read with the Cora connection's own credential, and Codara
        // never borrows the command-line tool's. So this card has no bars to
        // show — and says why, rather than looking like an account with no
        // limits. Nothing here is fetched or guessed.
        <div
          style={{
            paddingTop: 5,
            borderTop: "1px solid var(--rule-soft)",
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            lineHeight: 1.35,
          }}
        >
          {CLI_ONLY_USAGE_HINT}
        </div>
      ) : null}

      {renaming ? (
        <RenameForm
          ariaLabel={`Rename ${card.label}`}
          initial={card.label}
          busy={coraFacetBusy || cliBusy}
          // A merged card names one account, so a rename applies to every side
          // that stores a name for it.
          onSave={async (label) => {
            let saved = false;
            if (cora) saved = await actions.onCoraRename(card, label);
            if (cli && (saved || !cora)) {
              const renamedCli = await actions.onCliRename(card, label);
              // Half a rename would split one account into two differently
              // named cards, so put the Cora side back and let the failure
              // stand on its own.
              if (!renamedCli && cora && saved) {
                await actions.onCoraRename(card, card.label);
              }
              saved = renamedCli;
            }
            if (saved) setRenaming(false);
            return saved;
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : visibleActions.length > 0 ? (
        // Primary/secondary buttons only — the "···" menu lives in the header
        // row above, so a card with no next step renders no action row at all.
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {visibleActions.map((action, index) => (
            <ActionButton
              key={action.id}
              compact
              disabled={action.disabled}
              primary={index === 0}
              onClick={() => void action.run()}
            >
              {action.label}
            </ActionButton>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AccountProviderGroup({
  view,
  actions,
}: {
  view: AccountProviderView;
  actions: AccountActions;
}) {
  const addBusy = view.addingCora || view.addingCli;

  return (
    <section
      aria-labelledby={`accounts-${view.provider}-title`}
      style={{
        display: "grid",
        gap: 7,
        padding: 9,
        borderRadius: "var(--radius-surface, 7px)",
        border: "1px solid var(--rule-soft)",
        background: "color-mix(in oklab, var(--ink) 2%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
          <span
            id={`accounts-${view.provider}-title`}
            style={{
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {view.label}
          </span>
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            {view.detail}
          </span>
        </div>
        <AddAccountMenu
          label={`Add a ${view.label} account`}
          primary={view.cards.length === 0}
          disabled={
            addBusy ||
            ((view.coraDisabled || view.coraBusy) &&
              (view.cliDisabled || view.cliLoading))
          }
          choices={[
            {
              id: "cora",
              title: "Connect to Cora",
              detail: "Used for chats, workers, and automations.",
              disabled: view.coraDisabled || view.coraBusy,
              onChoose: () => actions.onBeginAddCora(view.provider),
            },
            {
              id: "cli",
              title: `Sign in to ${view.cliLabel}`,
              detail: `Used when you run ${view.cliLabel} in the terminal. Name it now, sign in next.`,
              disabled: view.cliDisabled || view.cliLoading,
              onChoose: () => actions.onBeginAddCli(view.provider),
            },
          ]}
        />
      </div>

      {view.addingCora ? (
        <AddAccountForm
          ariaLabel={`Name for the new ${view.label} account in Cora`}
          placeholder="Name this account (optional)"
          submitLabel="Connect"
          value={view.addCoraLabel}
          disabled={view.coraDisabled}
          onValue={actions.onAddCoraLabel}
          onSubmit={() => actions.onAddCora(view.provider)}
          onCancel={actions.onCancelAddCora}
        />
      ) : null}

      {view.addingCli ? (
        <AddAccountForm
          ariaLabel={`Name for the new ${view.cliLabel} account`}
          placeholder="Name this account"
          submitLabel="Continue"
          value={view.addCliLabel}
          disabled={view.cliDisabled || !view.addCliLabel.trim()}
          onValue={actions.onAddCliLabel}
          onSubmit={() => actions.onAddCli(view.provider)}
          onCancel={actions.onCancelAddCli}
        />
      ) : null}

      {view.cliError ? (
        <div
          role="alert"
          style={{
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
          }}
        >
          The {view.cliLabel} sign-in status could not be loaded. Try again.
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 5 }}>
        {view.cards.map((card) => (
          <AccountCard
            key={card.key}
            card={card}
            cliLabel={view.cliLabel}
            coraDisabled={view.coraDisabled}
            coraBusy={view.coraBusy}
            cliDisabled={view.cliDisabled}
            actions={actions}
          />
        ))}
        {view.cliPersonalMissing ? (
          <div
            aria-disabled="true"
            style={{
              display: "grid",
              gap: 4,
              padding: "7px 9px",
              borderRadius: "var(--radius-control, 5px)",
              border: "1px solid var(--rule-soft)",
              background: "color-mix(in oklab, var(--ink) 3%, transparent)",
            }}
          >
            <span
              style={{
                color: "var(--ink)",
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                fontWeight: 650,
                lineHeight: 1.35,
              }}
            >
              Personal
            </span>
            <ConnectionLine
              state={{
                ok: false,
                text: `The sign-in ${view.cliLabel} came with. Codara cannot check this one.`,
              }}
            />
          </div>
        ) : null}
        {view.cliLoading ? (
          <div
            role="status"
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              padding: "4px 2px",
            }}
          >
            Checking {view.cliLabel} accounts…
          </div>
        ) : null}
        {view.cards.length === 0 && !view.cliLoading && !view.cliPersonalMissing ? (
          <div
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              padding: "4px 2px",
            }}
          >
            No {view.label} account yet.
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default function AccountCards({
  providers,
  actions,
}: {
  providers: ReadonlyArray<AccountProviderView>;
  actions: AccountActions;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {providers.map((view) => (
        <AccountProviderGroup key={view.provider} view={view} actions={actions} />
      ))}
    </div>
  );
}
