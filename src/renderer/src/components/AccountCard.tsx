import React, { useState } from "react";
import type { PiSubscriptionProvider } from "@shared/types";
import { agentBrandColor } from "../lib/agent-brand";
import type { AccountProviderDescriptor } from "../lib/account-provider-descriptors";
import {
  ActionButton,
  ActiveBadge,
  CardOverflowMenu,
  ConnectionLine,
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
 *   active                  the account Cora and the terminal tool are using
 *   signed-in               signed in, one click away from being active
 *   needs-reconnect         the Cora sign-in lapsed with no way back
 *   terminal-only           a terminal sign-in Cora does not have yet
 *   cora-only               a Cora sign-in the terminal tool does not have yet
 *   account-one-signed-out  the user's own CLI login, currently absent
 */
export type AccountCardState =
  | "active"
  | "signed-in"
  | "needs-reconnect"
  | "terminal-only"
  | "cora-only"
  | "account-one-signed-out";

export interface AccountCardView {
  /** Stable across pairing: <provider>:<coraId>, <provider>:cli:<cliId>, or <provider>:account-one. */
  key: string;
  provider: PiSubscriptionProvider;
  label: string;
  /** Shown under the name so two similarly named accounts are tellable apart. */
  email?: string;
  /** Plan name, e.g. "Max". */
  plan?: string;
  /** Cora row id. Absent on a terminal-only half and on the unlinked Account 1 slot. */
  coraProfileId?: string;
  /** Terminal half id. Absent on a Cora-only row. */
  cliProfileId?: string;
  /** Account 1: the user's own CLI login. Renameable, never deleted or reconnected here. */
  builtIn: boolean;
  /** The account Cora and the terminal tool are running on; both switch together. */
  active: boolean;
  cora?: {
    connected: boolean;
    expired: boolean;
    canRefresh: boolean;
    error?: string;
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
  /** Said in place of the meters when this account has none to draw. */
  usageNote?: string;
  /**
   * Terminals still running on this account (the count main refused a delete
   * with, or the live count): the next Delete closes that many first.
   */
  closeSessionsCount?: number;
  /**
   * Set after main refused a switch because terminals are running on this
   * account: the next Use closes that many first. Only a provider whose
   * switch closes sessions (Codex) ever reports it.
   */
  switchCloseSessionsCount?: number;
}

export interface AccountCardActions {
  /** Switch Cora and the terminal tool to this account together. */
  onUse: (card: AccountCardView, options: { closeSessions: boolean }) => void;
  /** Browser sign-in that rewrites both halves of this account. */
  onReconnect: (card: AccountCardView) => void;
  /** Give a half account its other half. */
  onShare: (card: AccountCardView) => void;
  onRename: (card: AccountCardView, label: string) => Promise<boolean>;
  onDelete: (
    card: AccountCardView,
    options: { closeSessions: boolean },
  ) => void;
}

export function accountCardState(card: AccountCardView): AccountCardState {
  if (!card.coraProfileId) {
    return card.builtIn ? "account-one-signed-out" : "terminal-only";
  }
  // Access tokens are short-lived and renewed silently from the refresh
  // token, so a lapsed one is the normal resting state between sessions.
  // Only a credential with no way back needs the user.
  const coraUsable =
    Boolean(card.cora?.connected) &&
    !(card.cora?.expired && !card.cora.canRefresh);
  if (card.builtIn && !coraUsable) return "account-one-signed-out";
  if (!coraUsable) return "needs-reconnect";
  if (!card.cliProfileId) return "cora-only";
  return card.active ? "active" : "signed-in";
}

export function accountOneSignedOutHint(
  descriptor: AccountProviderDescriptor,
): string {
  return `Run ${descriptor.loginHint} in a terminal to use this account.`;
}

/** Usable the way Cora counts it: present, and not expired without a way back. */
function terminalUsable(card: AccountCardView): boolean {
  return (
    Boolean(card.terminal?.connected) &&
    !(card.terminal?.expired && !card.terminal.canRefresh)
  );
}

function sessions(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

function connectionState(
  card: AccountCardView,
  state: AccountCardState,
  descriptor: AccountProviderDescriptor,
): ConnectionState {
  const { cliLabel } = descriptor;
  // Account 1 always says what to do; a raw store error on its own would
  // hide the one instruction that helps.
  if (card.cora?.error && state !== "account-one-signed-out") {
    return { ok: false, text: card.cora.error, danger: true };
  }
  switch (state) {
    case "needs-reconnect":
      return {
        ok: false,
        text: "The Cora sign-in expired. Reconnect to keep using this account.",
        danger: true,
      };
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
          text: `${cliLabel} cannot use this profile's folder. Delete it and add the account again.`,
          danger: true,
        };
      }
      if (!card.terminal?.connected) {
        return {
          ok: false,
          text: `Not signed in to ${cliLabel}. Delete it and add the account again.`,
        };
      }
      return {
        ok: false,
        text: card.cliDefault
          ? `Signed in to ${cliLabel} only, and the terminal is using it. Share it so Cora can use it too.`
          : `Signed in to ${cliLabel} only. Share it so Cora can use it too.`,
      };
    case "account-one-signed-out":
      return {
        ok: false,
        text: terminalUsable(card)
          ? `Found your ${descriptor.loginHint}. Cora is linking it now.`
          : card.cora?.error
            ? `${card.cora.error} ${accountOneSignedOutHint(descriptor)}`
            : accountOneSignedOutHint(descriptor),
      };
    case "active":
    case "signed-in":
      if (card.cora?.expired && card.cora.canRefresh) {
        return { ok: true, text: "Refreshing the Cora sign-in." };
      }
      if (card.terminal && !card.terminal.connected) {
        return {
          ok: true,
          text: `Signed in to Cora. The ${cliLabel} copy is catching up.`,
        };
      }
      return { ok: true, text: `Signed in to Cora and ${cliLabel}.` };
  }
}

function primaryAction(
  card: AccountCardView,
  state: AccountCardState,
  descriptor: AccountProviderDescriptor,
  actions: AccountCardActions,
  disabled: boolean,
): CardAction | undefined {
  switch (state) {
    case "active":
    case "account-one-signed-out":
      return undefined;
    case "signed-in": {
      // Main refused the switch with a count; the same button now closes
      // those sessions and switches. Only Codex ever reports one.
      const switchCount = card.switchCloseSessionsCount ?? 0;
      return {
        id: "use",
        label:
          switchCount > 0
            ? `Close ${sessions(switchCount)} and switch`
            : "Switch to this account",
        disabled,
        run: () => actions.onUse(card, { closeSessions: switchCount > 0 }),
      };
    }
    case "needs-reconnect":
      return {
        id: "reconnect",
        label: "Reconnect",
        disabled,
        run: () => actions.onReconnect(card),
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
  const [deleteArmed, setDeleteArmed] = useState(false);
  const brand = agentBrandColor(descriptor.brand);
  const state = accountCardState(card);
  const controlsDisabled = disabled || card.busy;
  const status = connectionState(card, state, descriptor);
  const action = primaryAction(card, state, descriptor, actions, controlsDisabled);
  const renameable = Boolean(card.coraProfileId || card.cliProfileId);

  const menuActions: CardAction[] = [];
  if (renameable) {
    menuActions.push({
      id: "rename",
      label: "Rename",
      disabled: controlsDisabled,
      run: () => {
        setRenaming(true);
        setDeleteArmed(false);
      },
    });
  }
  const destructiveActions: CardAction[] = [];
  if (renameable) {
    // Account 1 is the user's own CLI login, so its card is FORGOTTEN rather
    // than deleted: the Cora sign-in and the pairing go, the login itself
    // stays, and no terminal has to close. The wording deliberately avoids
    // the retired two-role vocabulary, where an action dropped one half of
    // a card that went on living as the other.
    const closeCount = card.builtIn ? 0 : card.closeSessionsCount ?? 0;
    destructiveActions.push({
      id: "delete",
      label: deleteArmed
        ? closeCount > 0
          ? `Close ${sessions(closeCount)} and delete`
          : card.builtIn
            ? "Confirm forget"
            : "Confirm delete"
        : card.builtIn
          ? "Forget this account"
          : "Delete",
      danger: true,
      disabled: controlsDisabled,
      run: () => {
        if (!deleteArmed) {
          setDeleteArmed(true);
          return false;
        }
        setDeleteArmed(false);
        actions.onDelete(card, { closeSessions: closeCount > 0 });
      },
    });
  }

  // The plain healthy states need no sentence: the Active badge or the
  // Switch button already says it. Anything else (a refresh in flight, a
  // half that is catching up, an error, a missing half) is spelled out.
  const healthy =
    (state === "active" || state === "signed-in") &&
    status.ok &&
    !card.cora?.expired &&
    !(card.terminal && !card.terminal.connected);
  // An error on a usable row gets its fix beside it instead of leaving the
  // user to hunt for one. Account 1 is the user's own CLI login and is never
  // reconnected from here, so it gets the command to run instead.
  const inlineReconnect =
    Boolean(status.danger && card.coraProfileId && !card.builtIn) && action?.id !== "reconnect";
  const signedOut = state === "account-one-signed-out" && !card.email;
  const initial = (card.label.trim().charAt(0) || "?").toUpperCase();

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
              {card.active ? <ActiveBadge label="Active" /> : null}
            </div>
            <div className="st-acct__meta">
              {card.email ? (
                <span className="st-acct__email" title={card.email}>
                  {card.email}
                </span>
              ) : (
                <span className="st-acct__email is-missing">
                  {signedOut ? "Not signed in" : "Email not reported"}
                </span>
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
              <ActionButton
                primary={action.id !== "use"}
                disabled={action.disabled}
                onClick={() => void action.run()}
              >
                {action.label}
              </ActionButton>
            ) : null}
            {menuActions.length > 0 || destructiveActions.length > 0 ? (
              <CardOverflowMenu
                label={`More actions for ${card.label}`}
                groups={[menuActions, destructiveActions]}
                onClose={() => setDeleteArmed(false)}
              />
            ) : null}
          </div>
        </div>

        {healthy ? null : (
          <ConnectionLine
            state={status}
            hint={
              status.danger && card.builtIn && state !== "account-one-signed-out"
                ? accountOneSignedOutHint(descriptor)
                : undefined
            }
            action={
              inlineReconnect ? (
                <ActionButton
                  primary
                  disabled={controlsDisabled}
                  onClick={() => actions.onReconnect(card)}
                >
                  Reconnect
                </ActionButton>
              ) : undefined
            }
          />
        )}

        {card.usage ? (
          <div className="st-acct__usage">{card.usage}</div>
        ) : (
          <div className="st-acct__usage-note">
            {state === "terminal-only"
              ? "Limits show once Cora can use this account."
              : state === "account-one-signed-out"
                ? "Limits show once this account is signed in."
                : card.usageNote ?? "No limits reported yet."}
          </div>
        )}

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
      </div>
    </div>
  );
}
