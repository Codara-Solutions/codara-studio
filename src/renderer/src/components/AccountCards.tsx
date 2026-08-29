import React, { useEffect, useRef, useState } from "react";
import {
  familyForRuntime,
  runtimeForSubscription,
  type AgentRuntimeKind,
} from "@shared/agent-families";
import type { PiSubscriptionProvider } from "@shared/types";
import { agentBrandColor } from "../lib/agent-brand";
import AnchoredMenu from "./chat/composer/AnchoredMenu";
import { CodaraMark, RuntimeMark } from "./BrandMarks";

export type NativeCliAccountRuntime = "claude" | "codex" | "grok";

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
  accountFingerprint?: string;
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
  /** Empty provider state that still offers both connection actions. */
  placeholder?: boolean;
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

type AddAccountDestination = "cora" | "cli";

export interface AccountActions {
  /** Connect a card that only has a CLI sign-in to Cora (same login flow as
   *  "Add account → Connect to Cora", seeded with the card's name). */
  onCoraConnect: (card: AccountCardView) => void;
  /**
   * Sign this account in to the command-line tool from a Cora-only card.
   * Uses the unsigned built-in slot when it is free, otherwise creates a
   * named CLI account and opens its sign-in.
   */
  onCliConnect: (card: AccountCardView) => void;
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
  color: "var(--accent-text)",
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
  color: "var(--accent-text)",
};

/**
 * Use-for-Cora and use-for-CLI live on their own role rows, always visible
 * when that side is not already selected. Everything else — rename, reconnect,
 * sign out, delete — waits behind the "···" menu. A fully connected active
 * card shows Using on both rows and no buttons.
 */

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
  tone,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  primary?: boolean;
  /** Card-scale rather than form-scale — see COMPACT_BUTTON_STYLE. */
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

function UsingChip({ label, color }: { label: string; color: string }) {
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
 * One independently switchable role on an account card. Cora and the CLI each
 * get a row so "use this account for Cora" and "use this account for Claude
 * Code" are always separate actions, never a combined "Use this account".
 */
function AccountRoleRow({
  label,
  mark,
  using,
  usingLabel,
  status,
  danger,
  action,
  brand,
}: {
  label: string;
  mark?: React.ReactNode;
  using: boolean;
  usingLabel: string;
  status?: string;
  danger?: boolean;
  action?: { id: string; label: string; disabled: boolean; run: () => void };
  brand: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        minHeight: 28,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          minWidth: 0,
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1.3,
        }}
      >
        {mark ? (
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              color: brand,
              flex: "0 0 auto",
            }}
          >
            {mark}
          </span>
        ) : null}
        {label}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 7,
          flex: "0 1 auto",
          minWidth: 0,
        }}
      >
        {using ? (
          <UsingChip label={usingLabel} color={brand} />
        ) : status ? (
          <span
            style={{
              color: danger ? "var(--danger)" : "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 10.5,
              lineHeight: 1.3,
              whiteSpace: "nowrap",
            }}
          >
            {status}
          </span>
        ) : null}
        {action ? (
          <ActionButton
            compact
            primary
            tone={brand}
            disabled={action.disabled}
            onClick={() => void action.run()}
          >
            {action.label}
          </ActionButton>
        ) : null}
      </span>
    </div>
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

export function AccountAddPicker({
  providers,
  actions,
}: {
  providers: ReadonlyArray<AccountProviderView>;
  actions: AccountActions;
}) {
  const [open, setOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<PiSubscriptionProvider | null>(null);
  const [destination, setDestination] =
    useState<AddAccountDestination | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedView = providers.find(
    (view) => view.provider === selectedProvider,
  );
  const selectedRuntime = selectedView
    ? runtimeForSubscription(selectedView.provider)
    : null;
  const selectedFamily = selectedRuntime
    ? familyForRuntime(selectedRuntime)
    : null;
  const providerDisabled = (view: AccountProviderView) =>
    (view.coraDisabled || view.coraBusy) &&
    (view.cliDisabled || view.cliLoading);
  const disabled = providers.every(providerDisabled);

  const clearActiveForm = () => {
    if (destination === "cora") actions.onCancelAddCora();
    if (destination === "cli") actions.onCancelAddCli();
  };

  const close = () => {
    clearActiveForm();
    setOpen(false);
    setSelectedProvider(null);
    setDestination(null);
  };

  const finish = () => {
    setOpen(false);
    setSelectedProvider(null);
    setDestination(null);
  };

  const back = () => {
    if (destination) {
      clearActiveForm();
      setDestination(null);
      return;
    }
    setSelectedProvider(null);
  };

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setSelectedProvider(null);
    setDestination(null);
  }, [disabled]);

  const stage = destination
    ? `${selectedProvider}:${destination}`
    : selectedProvider ?? "provider";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="spark-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Add an account"
        disabled={disabled}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setSelectedProvider(null);
          setDestination(null);
          setOpen(true);
        }}
        style={{
          ...PRIMARY_BUTTON_STYLE,
          flex: "0 0 auto",
          ...(disabled ? { cursor: "default", opacity: 0.5 } : {}),
        }}
      >
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>+</span>
        Add account
      </button>
      {/* Portalled because Settings' scrolling pane clips in-place popovers. */}
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        className="spark-menu"
        role="dialog"
        ariaLabel="Add an account"
        placement="below"
        align="end"
        focusSignal={stage}
        zIndex={SETTINGS_MENU_Z}
      >
        <div style={{ width: 388, display: "grid", gap: 8, padding: 5 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: selectedProvider
                ? "26px minmax(0, 1fr) 26px"
                : "minmax(0, 1fr) 26px",
              alignItems: "start",
              gap: 7,
              padding: "3px 3px 5px",
            }}
          >
            {selectedProvider ? (
              <button
                type="button"
                className="spark-btn"
                aria-label="Back"
                onClick={back}
                style={{ ...BUTTON_STYLE, width: 26, minHeight: 26, padding: 0 }}
              >
                ←
              </button>
            ) : null}
            <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
              <span
                style={{
                  color: "var(--ink)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                {!selectedView
                  ? "Choose an agent"
                  : destination
                    ? `Name this ${selectedFamily?.displayName} account`
                    : `Add ${selectedFamily?.displayName}`}
              </span>
              <span
                style={{
                  color: "var(--muted)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 10.5,
                  lineHeight: 1.4,
                }}
              >
                {!selectedView
                  ? "Pick the account you want to connect."
                  : destination
                    ? destination === "cli"
                      ? "Name it now; the sign-in terminal opens next."
                      : "A clear name makes switching accounts easy later."
                    : "Choose where this sign-in should be used."}
              </span>
            </div>
            <button
              type="button"
              className="spark-btn"
              aria-label="Close account picker"
              onClick={close}
              style={{
                ...BUTTON_STYLE,
                width: 26,
                minHeight: 26,
                padding: 0,
                color: "var(--muted)",
              }}
            >
              ×
            </button>
          </div>

          {!selectedView ? (
            <div
              role="listbox"
              aria-label="Agent"
              style={{ display: "grid", gap: 5 }}
            >
              {providers.map((view) => {
                const runtime = runtimeForSubscription(view.provider);
                const family = familyForRuntime(runtime);
                const brand = agentBrandColor(runtime);
                const unavailable = providerDisabled(view);
                return (
                  <button
                    key={view.provider}
                    type="button"
                    role="option"
                    aria-selected="false"
                    className="spark-menu-item"
                    disabled={unavailable}
                    onClick={() => setSelectedProvider(view.provider)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "38px minmax(0, 1fr) auto",
                      alignItems: "center",
                      gap: 10,
                      minHeight: 54,
                      padding: "8px 10px",
                      textAlign: "left",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 36,
                        height: 36,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 10,
                        color: brand,
                        border: `1px solid color-mix(in oklch, ${brand} 34%, transparent)`,
                        background: `color-mix(in oklch, ${brand} 14%, transparent)`,
                      }}
                    >
                      <RuntimeMark runtime={runtime} size={20} />
                    </span>
                    <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                      <span
                        style={{
                          color: "var(--ink)",
                          fontSize: 12.5,
                          fontWeight: 700,
                        }}
                      >
                        {family.displayName}
                      </span>
                      <span
                        style={{
                          color: "var(--muted)",
                          fontSize: 10.5,
                          lineHeight: 1.35,
                        }}
                      >
                        {view.label} · Cora or {view.cliLabel}
                      </span>
                    </span>
                    <span aria-hidden style={{ color: brand, fontSize: 18 }}>›</span>
                  </button>
                );
              })}
            </div>
          ) : !destination ? (
            <div
              role="listbox"
              aria-label={`Where to use ${selectedFamily?.displayName}`}
              style={{ display: "grid", gap: 5 }}
            >
              <button
                type="button"
                role="option"
                aria-selected="false"
                className="spark-menu-item"
                disabled={selectedView.coraDisabled || selectedView.coraBusy}
                onClick={() => {
                  setDestination("cora");
                  actions.onBeginAddCora(selectedView.provider);
                }}
                style={{ minHeight: 52, padding: "8px 10px" }}
              >
                <span
                  aria-hidden
                  style={{ display: "inline-flex", color: "var(--accent)" }}
                >
                  <CodaraMark size={20} />
                </span>
                <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                  <span
                    style={{
                      color: "var(--ink)",
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    Connect to Cora
                  </span>
                  <span
                    style={{
                      color: "var(--muted)",
                      fontSize: 10.5,
                      lineHeight: 1.35,
                    }}
                  >
                    Use it for Cora chats, workers, and automations.
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="option"
                aria-selected="false"
                className="spark-menu-item"
                disabled={selectedView.cliDisabled || selectedView.cliLoading}
                onClick={() => {
                  setDestination("cli");
                  actions.onBeginAddCli(selectedView.provider);
                }}
                style={{ minHeight: 52, padding: "8px 10px" }}
              >
                <span
                  aria-hidden
                  style={{
                    display: "inline-flex",
                    color: agentBrandColor(selectedRuntime!),
                  }}
                >
                  <RuntimeMark runtime={selectedRuntime!} size={20} />
                </span>
                <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                  <span
                    style={{
                      color: "var(--ink)",
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    Sign in to {selectedView.cliLabel}
                  </span>
                  <span
                    style={{
                      color: "var(--muted)",
                      fontSize: 10.5,
                      lineHeight: 1.35,
                    }}
                  >
                    Use it when you run {selectedView.cliLabel} in a terminal.
                  </span>
                </span>
              </button>
            </div>
          ) : (
            <form
              aria-label={`Name for the new ${selectedFamily?.displayName} account`}
              onSubmit={(event) => {
                event.preventDefault();
                if (destination === "cora") {
                  if (selectedView.coraDisabled) return;
                  actions.onAddCora(selectedView.provider);
                } else {
                  if (
                    selectedView.cliDisabled ||
                    !selectedView.addCliLabel.trim()
                  ) return;
                  actions.onAddCli(selectedView.provider);
                }
                finish();
              }}
              style={{ display: "grid", gap: 8, padding: "2px 3px 3px" }}
            >
              <input
                autoFocus
                aria-label={`Name for the new ${selectedFamily?.displayName} account`}
                className="spark-input"
                maxLength={80}
                placeholder={
                  destination === "cora"
                    ? "Account name (optional)"
                    : "Account name"
                }
                value={
                  destination === "cora"
                    ? selectedView.addCoraLabel
                    : selectedView.addCliLabel
                }
                onChange={(event) => {
                  if (destination === "cora") {
                    actions.onAddCoraLabel(event.currentTarget.value);
                  } else {
                    actions.onAddCliLabel(event.currentTarget.value);
                  }
                }}
                style={INPUT_STYLE}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 6,
                }}
              >
                <ActionButton onClick={back}>Back</ActionButton>
                <button
                  type="submit"
                  className="spark-btn is-primary"
                  disabled={
                    destination === "cora"
                      ? selectedView.coraDisabled
                      : selectedView.cliDisabled ||
                        !selectedView.addCliLabel.trim()
                  }
                >
                  {destination === "cora" ? "Connect" : "Continue"}
                </button>
              </div>
            </form>
          )}
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
  runtime,
  cliLabel,
  coraDisabled,
  coraBusy,
  cliDisabled,
  actions,
}: {
  card: AccountCardView;
  runtime: AgentRuntimeKind;
  cliLabel: string;
  coraDisabled: boolean;
  coraBusy: boolean;
  cliDisabled: boolean;
  actions: AccountActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState<"cora" | "cli" | null>(null);
  const [cliSwitchArmed, setCliSwitchArmed] = useState(false);

  useEffect(() => {
    if (!cliSwitchArmed) return;
    const timer = window.setTimeout(() => setCliSwitchArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [cliSwitchArmed]);

  const cora = card.cora;
  const cli = card.cli;
  const cliOnly = Boolean(cli && !cora);
  const cliBusy = Boolean(cli?.busyAction);
  const coraFacetBusy = Boolean(cora?.busy);
  const brand = agentBrandColor(runtime);
  // Cora switches immediately. CLI activation closes the runtime's live
  // sessions first because an already-running process cannot have its account
  // environment or cached credentials changed safely underneath it.
  const coraUsing = Boolean(cora?.connected && !cora.expired && cora.active);
  const cliUsing = Boolean(cli?.authState === "connected" && cli.active);
  const active = coraUsing || cliUsing;
  const coraControlsDisabled = coraDisabled || coraBusy;
  const cliMutationDisabled = cliDisabled || cliBusy;
  const cliControlsDisabled =
    cliMutationDisabled || Boolean(cli?.inUse);
  const cliSwitchDisabled = cliDisabled || cliBusy;
  const cliNeedsSignIn =
    !cli ||
    cli.authState === "signed-out" ||
    cli.authState === "expired" ||
    cli.authState === "error";
  const signInHint = cliSignInHint(cli, cliLabel);

  const coraAction: CardAction | undefined = (() => {
    if (!cora) {
      return {
        id: "cora-connect",
        label: "Connect to Cora",
        disabled: coraControlsDisabled,
        run: () => actions.onCoraConnect(card),
      };
    }
    if (!cora.connected) {
      return {
        id: "cora-connect",
        label: "Connect to Cora",
        disabled: coraControlsDisabled,
        run: () => actions.onCoraReconnect(card),
      };
    }
    if (cora.expired) {
      return {
        id: "cora-reconnect",
        label: "Reconnect to Cora",
        disabled: coraControlsDisabled,
        run: () => actions.onCoraReconnect(card),
      };
    }
    if (!cora.active) {
      return {
        id: "cora-use",
        label: "Use this account for Cora",
        disabled: coraControlsDisabled,
        run: () => actions.onCoraUse(card),
      };
    }
    return undefined;
  })();

  const cliAction: CardAction | undefined = (() => {
    if (cliNeedsSignIn) {
      return {
        id: "cli-sign-in",
        label:
          cli && cli.authState !== "signed-out"
            ? `Sign in to ${cliLabel} again`
            : `Sign in to ${cliLabel}`,
        disabled: cliDisabled || cliBusy,
        run: () =>
          cli ? actions.onCliSignIn(card) : actions.onCliConnect(card),
      };
    }
    if (cli && !cli.active) {
      return {
        id: "cli-use",
        label: cliSwitchArmed
          ? `Confirm & close ${cliLabel}`
          : `Use this account for ${cliLabel}`,
        disabled: cliSwitchDisabled,
        run: () => {
          if (!cliSwitchArmed) {
            setCliSwitchArmed(true);
            return;
          }
          setCliSwitchArmed(false);
          actions.onCliUse(card);
        },
      };
    }
    return undefined;
  })();

  const coraState = coraConnectionState(cora);
  const cliState = cliConnectionState(cli, cliLabel);

  const menuActions: CardAction[] = [];
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
  if (cora || cli) {
    menuActions.push({
      id: "rename",
      label: "Rename",
      // Renaming only changes Codara's local label. An active CLI process must
      // block credential mutations, but it has no reason to block this metadata
      // edit. For paired cards, wait for both facets' real mutations to finish.
      disabled:
        (cora ? coraControlsDisabled : false) ||
        (cli ? cliMutationDisabled : false),
      run: () => {
        setRenaming(true);
        setDeleteArmed(null);
      },
    });
  }
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
        gap: 10,
        padding: "12px 13px",
        borderRadius: "var(--radius-surface, 7px)",
        border: "1px solid var(--rule)",
        background: "var(--panel-2)",
        boxShadow: active
          ? `inset 2px 0 0 ${brand}`
          : "none",
      }}
    >
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
            gridAutoColumns: "minmax(0, max-content)",
            justifyContent: "start",
            alignItems: "baseline",
            columnGap: 7,
          }}
        >
          <span
            style={{
              minWidth: 0,
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: 650,
              lineHeight: 1.3,
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
                fontSize: 11,
                lineHeight: 1.3,
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
                fontSize: 10.5,
                lineHeight: 1.3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {card.plan} plan
            </span>
          ) : null}
        </div>
        {menuActions.length > 0 || destructiveActions.length > 0 ? (
          <CardOverflowMenu
            label={`More actions for ${card.label}`}
            groups={[menuActions, destructiveActions]}
            onClose={() => setDeleteArmed(null)}
          />
        ) : null}
      </div>

      <div style={{ display: "grid", gap: 0 }}>
        <AccountRoleRow
          label="Cora"
          mark={<CodaraMark size={13} />}
          brand="var(--accent)"
          using={coraUsing}
          usingLabel="Using"
          status={
            coraUsing || (coraAction && !coraState.danger)
              ? undefined
              : coraState.text
          }
          danger={coraState.danger}
          action={coraAction}
        />
        <div
          aria-hidden
          style={{
            height: 1,
            background: "var(--rule-soft)",
            margin: "6px 0",
          }}
        />
        <AccountRoleRow
          label={cliLabel}
          mark={<RuntimeMark runtime={runtime} size={13} />}
          brand={brand}
          using={cliUsing}
          usingLabel="Using"
          status={
            cliUsing || (cliAction && !cliState.danger)
              ? undefined
              : cliState.text
          }
          danger={cliState.danger}
          action={cliAction}
        />
      </div>

      {signInHint ? (
        <div
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10.5,
            lineHeight: 1.4,
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
            fontSize: 10.5,
            lineHeight: 1.4,
          }}
        >
          {card.pairHint}
        </div>
      ) : null}

      {card.usage ? (
        <div
          style={{
            display: "grid",
            gap: 6,
            paddingTop: 10,
            borderTop: "1px solid var(--rule-soft)",
          }}
        >
          {card.usage}
        </div>
      ) : cliOnly ? (
        <div
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10.5,
            lineHeight: 1.4,
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
          onSave={async (label) => {
            let saved = false;
            if (cora) saved = await actions.onCoraRename(card, label);
            if (cli && (saved || !cora)) {
              const renamedCli = await actions.onCliRename(card, label);
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
  const runtime = runtimeForSubscription(view.provider);
  const brand = agentBrandColor(runtime);

  return (
    <section
      aria-labelledby={`accounts-${view.provider}-title`}
      style={{
        display: "grid",
        gap: 8,
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
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            <span aria-hidden style={{ display: "inline-flex", color: brand }}>
              <RuntimeMark runtime={runtime} size={16} />
            </span>
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
      </div>

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

      <div style={{ display: "grid", gap: 8 }}>
        {view.cards.map((card) => (
          <AccountCard
            key={card.key}
            card={card}
            runtime={runtime}
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
    <div style={{ display: "grid", gap: 18 }}>
      {providers.map((view) => (
        <AccountProviderGroup key={view.provider} view={view} actions={actions} />
      ))}
    </div>
  );
}
