import React, { useState } from "react";
import type { PiSubscriptionProvider } from "@shared/types";
import { agentBrandColor } from "../lib/agent-brand";
import {
  systemLoginBadge,
  type AccountProviderDescriptor,
} from "../lib/account-provider-descriptors";
import { UsagePlaceholder } from "./SubscriptionUsage";
import {
  ActionButton,
  ActiveBadge,
  CardOverflowMenu,
  ConnectionLine,
  RemoveConfirm,
  RenameForm,
  type CardAction,
  type ConnectionState,
} from "./AccountCardPrimitives";

/**
 * One account is one card, for every provider. The main process owns the
 * pairing: a Cora row carries the id of its terminal half (Claude Code,
 * Codex or Grok), so this component never matches anything itself. It only
 * reads the ids back through callbacks and never renders them. Which
 * provider the card is for changes the words and the brand, nothing else.
 *
 * A card is one of six states, derived below from what main reported:
 *   active           the account new Cora chats and Codara terminals use
 *   signed-in        signed in, one click away from being active
 *   needs-reconnect  the Cora sign-in lapsed with no way back
 *   terminal-only    a terminal sign-in Cora does not have yet
 *   cora-only        a Cora sign-in the terminal tool does not have yet
 *   system           the CLI's own login on this computer, used as it is
 */
export type AccountCardState =
  | "active"
  | "signed-in"
  | "needs-reconnect"
  | "terminal-only"
  | "cora-only"
  | "system";

export interface AccountCardView {
  /** Stable across pairing: <provider>:<coraId> or <provider>:cli:<cliId>. */
  key: string;
  provider: PiSubscriptionProvider;
  label: string;
  /** Shown under the name so two similarly named accounts are tellable apart. */
  email?: string;
  /** Plan name, e.g. "Max". */
  plan?: string;
  /** Cora row id. Absent on a terminal-only half. */
  coraProfileId?: string;
  /** Terminal half id. Absent on a Cora-only row. */
  cliProfileId?: string;
  /** The CLI's own login on this computer, which Codara never changes. */
  builtIn: boolean;
  /** The account new sessions use; Cora and the terminal tool switch together. */
  active: boolean;
  cora?: {
    connected: boolean;
    expired: boolean;
    canRefresh: boolean;
    error?: string;
    /** False when the row holds no Cora grant at all (a System row before Connect Cora). */
    held?: boolean;
  };
  terminal?: {
    connected: boolean;
    expired?: boolean;
    canRefresh?: boolean;
    /** The tool refuses the profile's folder (permissions); not a sign-out. */
    unsafe?: boolean;
  };
  /** A terminal-only half that the terminal tool is currently set to. */
  cliDefault?: boolean;
  busy: boolean;
  /** Usage limits for this account, rendered inside the card body. */
  usage?: React.ReactNode;
  /** Said on the empty meters when this account has no reading to draw. */
  usageNote?: string;
  /** Why the last limit read failed, said once under the empty meters. */
  usageMessage?: string;
}

export interface AccountCardActions {
  /** Make this the Active account for new sessions. */
  onUse: (card: AccountCardView) => void;
  /** Browser sign-in that rewrites this account's Cora grant (and its managed copy). */
  onReconnect: (card: AccountCardView) => void;
  /** Give a half account its other half. */
  onShare: (card: AccountCardView) => void;
  onRename: (card: AccountCardView, label: string) => Promise<boolean>;
  onDelete: (card: AccountCardView) => void;
}

/** Usable the way Cora counts it: held, present, and not expired without a way back. */
function coraUsable(card: AccountCardView): boolean {
  return (
    card.cora?.held !== false &&
    Boolean(card.cora?.connected) &&
    !(card.cora?.expired && !card.cora.canRefresh)
  );
}

function terminalUsable(card: AccountCardView): boolean {
  return (
    Boolean(card.terminal?.connected) &&
    !(card.terminal?.expired && !card.terminal.canRefresh)
  );
}

export function accountCardState(card: AccountCardView): AccountCardState {
  if (card.builtIn) return "system";
  if (!card.coraProfileId) return "terminal-only";
  // Access tokens are short-lived and renewed silently from the refresh
  // token, so a lapsed one is the normal resting state between sessions.
  // Only a credential with no way back needs the user.
  if (!coraUsable(card)) return "needs-reconnect";
  if (!card.cliProfileId) return "cora-only";
  return card.active ? "active" : "signed-in";
}

/**
 * Ready is what the row shows, never a separate guess: an account counts
 * when its row carries the Active badge with no problem under it, or the
 * Switch button. A System row counts while its own login is signed in,
 * since terminals can use it whether or not Cora is connected.
 */
export function accountCardReady(card: AccountCardView): boolean {
  const state = accountCardState(card);
  if (state === "system") return terminalUsable(card);
  return (state === "active" || state === "signed-in") && !card.cora?.error;
}

/**
 * The state alone, without the instruction that follows it. A row whose
 * button already carries the fix shows only this, so the sentence and the
 * button never say the same thing twice.
 */
function firstSentence(text: string): string {
  const match = /^(.+?)[.!?](?:\s|$)/.exec(text);
  return match ? match[1] : text;
}

function connectionState(
  card: AccountCardView,
  state: AccountCardState,
  descriptor: AccountProviderDescriptor,
): ConnectionState {
  const { cliLabel } = descriptor;
  if (card.cora?.error && state !== "system" && state !== "terminal-only") {
    return { ok: false, text: card.cora.error, danger: true };
  }
  switch (state) {
    case "system":
      return terminalUsable(card)
        ? { ok: true, text: "Codara uses this login as it is and never changes it." }
        : {
            ok: false,
            text: `${cliLabel} on this computer is signed out. Codara uses this login as it is and never changes it.`,
          };
    case "needs-reconnect":
      return { ok: false, text: "Sign-in expired.", danger: true };
    case "cora-only":
      return {
        ok: false,
        text: `Signed in to Cora only. Share it so ${cliLabel} can use it too.`,
      };
    case "terminal-only":
      // Nothing here signs a managed profile in again; the only way forward
      // is a fresh add, so the line says so.
      if (card.terminal?.unsafe) {
        return {
          ok: false,
          text: `${cliLabel} cannot use this profile's folder. Remove it and add the account again.`,
          danger: true,
        };
      }
      if (!card.terminal?.connected) {
        return {
          ok: false,
          text: `Not signed in to ${cliLabel}. Remove it and add the account again.`,
        };
      }
      return {
        ok: false,
        text: `Signed in to ${cliLabel} only. Share it so Cora can use it too.`,
      };
    case "active":
    case "signed-in":
      if (card.cora?.expired && card.cora.canRefresh) {
        return { ok: true, text: "Refreshing the sign-in." };
      }
      if (card.terminal && !card.terminal.connected) {
        return { ok: true, text: `Signed in. The ${cliLabel} copy is catching up.` };
      }
      return { ok: true, text: "Signed in. Only Codara uses this account." };
  }
}

/** The second line on a System row: whether Cora has its own grant for it. */
function systemCoraState(card: AccountCardView): ConnectionState {
  if (coraUsable(card)) return { ok: true, text: "Cora: connected" };
  if (card.cora?.held !== false && card.cora?.connected) {
    return { ok: false, text: "Cora's sign-in expired.", danger: true };
  }
  return { ok: false, text: "Cora isn't connected." };
}

function primaryAction(
  card: AccountCardView,
  state: AccountCardState,
  status: ConnectionState,
  descriptor: AccountProviderDescriptor,
  actions: AccountCardActions,
  disabled: boolean,
): CardAction | undefined {
  // A lapsed sign-in is fixed by reconnecting it, never by switching to it.
  if (status.danger && card.coraProfileId && state !== "system" && state !== "terminal-only") {
    return {
      id: "reconnect",
      label: "Reconnect",
      disabled,
      run: () => actions.onReconnect(card),
    };
  }
  switch (state) {
    case "active":
    case "needs-reconnect":
      return undefined;
    case "system":
      if (card.active || !terminalUsable(card)) return undefined;
      return {
        id: "use",
        label: "Switch to this account",
        title: `New sessions use your own ${descriptor.cliLabel} login`,
        disabled,
        run: () => actions.onUse(card),
      };
    case "signed-in":
      return {
        id: "use",
        label: "Switch to this account",
        disabled,
        run: () => actions.onUse(card),
      };
    case "cora-only":
      return {
        id: "share",
        label: `Share with ${descriptor.cliLabel}`,
        disabled,
        run: () => actions.onShare(card),
      };
    case "terminal-only":
      if (!card.terminal?.connected) return undefined;
      return {
        id: "share",
        label: "Share with Cora",
        disabled,
        run: () => actions.onShare(card),
      };
  }
}

/** The text a Remove asks to confirm (accounts spec 13). */
export function removeConfirmText(
  card: AccountCardView,
  descriptor: AccountProviderDescriptor,
): string {
  const { cliLabel } = descriptor;
  if (card.builtIn) {
    return `Remove "${card.label}" from Codara? Your ${cliLabel} login stays as it is. Codara stops offering it.`;
  }
  return `Remove "${card.label}"? Codara deletes this sign-in from its own folder. Your ${cliLabel} login outside Codara is not affected. This can't be undone; to use it again, add it again.`;
}

export default function AccountCard({
  card,
  descriptor,
  disabled,
  actions,
}: {
  card: AccountCardView;
  descriptor: AccountProviderDescriptor;
  /** The Pi runtime is missing or another account action is in flight. */
  disabled: boolean;
  actions: AccountCardActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const brand = agentBrandColor(descriptor.brand);
  const state = accountCardState(card);
  const controlsDisabled = disabled || card.busy;
  const status = connectionState(card, state, descriptor);
  const action = primaryAction(card, state, status, descriptor, actions, controlsDisabled);
  const renameable = Boolean(card.coraProfileId || card.cliProfileId);

  const menuActions: CardAction[] = [];
  if (renameable) {
    menuActions.push({
      id: "rename",
      label: "Rename",
      disabled: controlsDisabled,
      run: () => {
        setRenaming(true);
        setConfirmingRemove(false);
      },
    });
  }
  const systemCora = state === "system" ? systemCoraState(card) : null;
  const destructiveActions: CardAction[] = [];
  if (renameable) {
    destructiveActions.push({
      id: "delete",
      label: card.builtIn ? "Remove from Codara" : "Remove",
      danger: true,
      disabled: controlsDisabled,
      run: () => {
        setConfirmingRemove(true);
        setRenaming(false);
      },
    });
  }

  const signedOut = state === "system" ? !terminalUsable(card) : false;
  const initial = (card.label.trim().charAt(0) || "?").toUpperCase();
  const connectCora =
    systemCora && !systemCora.ok && card.coraProfileId ? (
      <ActionButton
        quiet
        disabled={controlsDisabled}
        onClick={() => actions.onReconnect(card)}
      >
        Connect Cora
      </ActionButton>
    ) : null;

  return (
    <div
      aria-busy={card.busy || undefined}
      aria-current={card.active ? "true" : undefined}
      className={`st-acct${card.active ? " is-active" : ""}${signedOut ? " is-signed-out" : ""}`}
    >
      <span
        aria-hidden
        className="st-acct__avatar"
        style={{
          color: brand,
          background: `color-mix(in oklch, ${brand} 15%, transparent)`,
        }}
      >
        {initial}
      </span>
      <div className="st-acct__body">
        <div className="st-acct__head">
          <div className="st-acct__id">
            <div className="st-acct__name-line">
              <span className="st-acct__name">{card.label}</span>
              {card.builtIn ? (
                <span className="st-acct-badge">{systemLoginBadge(descriptor)}</span>
              ) : null}
              {card.active ? <ActiveBadge label="Active" /> : null}
            </div>
            <div className="st-acct__meta">
              {/* A System row is named after its email by default; one line of it is enough. */}
              {card.email && card.email === card.label ? null : card.email ? (
                <span className="st-acct__email" title={card.email}>
                  {card.email}
                </span>
              ) : (
                <span className="st-acct__email is-missing">Email not reported</span>
              )}
              {card.plan ? <span className="st-acct__plan">{card.plan} plan</span> : null}
            </div>
          </div>
          <div className="st-acct__actions">
            {card.busy ? (
              <span className="st-acct__working">
                <span aria-hidden className="st-spinner" />
                Working…
              </span>
            ) : action ? (
              // Every row action is the same quiet button: the only accent in
              // the list is the Active badge and its rule.
              <ActionButton
                disabled={action.disabled}
                title={action.title}
                onClick={() => void action.run()}
              >
                {action.label}
              </ActionButton>
            ) : null}
            {/* A row with nothing in its menu keeps the menu's slot, so every
                row's button ends on the same edge down the list. */}
            {menuActions.length > 0 || destructiveActions.length > 0 ? (
              <CardOverflowMenu
                label={`More actions for ${card.label}`}
                groups={[menuActions, destructiveActions]}
                onClose={() => undefined}
              />
            ) : (
              <span aria-hidden className="st-acct__menu-slot" />
            )}
          </div>
        </div>

        <ConnectionLine
          state={action && status.danger ? { ...status, text: firstSentence(status.text) } : status}
          title={status.text}
        />
        {systemCora ? <ConnectionLine state={systemCora} action={connectCora} /> : null}

        <div className="st-acct__usage">
          {card.usage ?? (
            <UsagePlaceholder
              labels={descriptor.usageWindows}
              note={card.usageNote ?? "Not available"}
              message={card.usageMessage}
            />
          )}
        </div>

        {renaming ? (
          <RenameForm
            ariaLabel={`Rename ${card.label}`}
            initial={card.label}
            busy={card.busy}
            onSave={async (label) => {
              const saved = await actions.onRename(card, label);
              if (saved) setRenaming(false);
              return saved;
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : null}

        {confirmingRemove ? (
          <RemoveConfirm
            text={removeConfirmText(card, descriptor)}
            confirmLabel={card.builtIn ? "Remove from Codara" : "Remove"}
            disabled={controlsDisabled}
            onConfirm={() => {
              setConfirmingRemove(false);
              actions.onDelete(card);
            }}
            onCancel={() => setConfirmingRemove(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
