import React, { useState } from "react";
import { agentBrandColor } from "../lib/agent-brand";
import {
  ActionButton,
  CardOverflowMenu,
  ConnectionLine,
  RenameForm,
  UsingChip,
  type CardAction,
  type ConnectionState,
} from "./AccountCardPrimitives";

/**
 * One Anthropic account is one card. The main process owns the pairing: a
 * Cora row carries the id of its Claude Code half, so this component never
 * matches anything itself. It only reads the ids back through callbacks and
 * never renders them.
 *
 * A card is one of six states, derived below from what main reported:
 *   active                  the account Cora and Claude Code are using
 *   signed-in               signed in, one click away from being active
 *   needs-reconnect         the Cora sign-in lapsed with no way back
 *   terminal-only           a Claude Code sign-in Cora does not have yet
 *   cora-only               a Cora sign-in Claude Code does not have yet
 *   account-one-signed-out  the user's own claude login, currently absent
 */
export type AnthropicAccountState =
  | "active"
  | "signed-in"
  | "needs-reconnect"
  | "terminal-only"
  | "cora-only"
  | "account-one-signed-out";

export interface AnthropicAccountCardView {
  /** Stable across pairing: anthropic:<coraId>, anthropic:cli:<cliId>, or anthropic:account-one. */
  key: string;
  label: string;
  /** Shown under the name so two similarly named accounts are tellable apart. */
  email?: string;
  /** Plan name, e.g. "Max". */
  plan?: string;
  /** Cora row id. Absent on a terminal-only half and on the unlinked Account 1 slot. */
  coraProfileId?: string;
  /** Claude Code half id. Absent on a Cora-only row. */
  cliProfileId?: string;
  /** Account 1: the user's own claude login. Renameable, never deleted or reconnected here. */
  builtIn: boolean;
  /** The account Cora and Claude Code are running on; both switch together. */
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
    /** Claude Code refuses the profile's folder (permissions); not a sign-out. */
    unsafe?: boolean;
  };
  /** A terminal-only half that Claude Code is currently set to. */
  cliDefault?: boolean;
  busy: boolean;
  /** Usage limits for this account, rendered inside the card body. */
  usage?: React.ReactNode;
  /**
   * Set after main refused a delete because terminals are still running on
   * this account: the next Delete closes that many sessions first.
   */
  closeSessionsCount?: number;
}

export interface AnthropicAccountActions {
  /** Switch Cora and Claude Code to this account together. */
  onUse: (card: AnthropicAccountCardView) => void;
  /** Browser sign-in that rewrites both halves of this account. */
  onReconnect: (card: AnthropicAccountCardView) => void;
  /** Give a half account its other half. */
  onShare: (card: AnthropicAccountCardView) => void;
  onRename: (card: AnthropicAccountCardView, label: string) => Promise<boolean>;
  onDelete: (
    card: AnthropicAccountCardView,
    options: { closeSessions: boolean },
  ) => void;
}

export function anthropicAccountState(
  card: AnthropicAccountCardView,
): AnthropicAccountState {
  if (!card.coraProfileId) {
    return card.builtIn ? "account-one-signed-out" : "terminal-only";
  }
  // Claude access tokens last about an hour and are renewed silently from
  // the refresh token, so a lapsed one is the normal resting state between
  // sessions. Only a credential with no way back needs the user.
  const coraUsable =
    Boolean(card.cora?.connected) &&
    !(card.cora?.expired && !card.cora.canRefresh);
  if (card.builtIn && !coraUsable) return "account-one-signed-out";
  if (!coraUsable) return "needs-reconnect";
  if (!card.cliProfileId) return "cora-only";
  return card.active ? "active" : "signed-in";
}

export const ACCOUNT_ONE_SIGNED_OUT_HINT =
  "Run claude login in a terminal to use this account.";

/** Usable the way Cora counts it: present, and not expired without a way back. */
function terminalUsable(card: AnthropicAccountCardView): boolean {
  return (
    Boolean(card.terminal?.connected) &&
    !(card.terminal?.expired && !card.terminal.canRefresh)
  );
}

function connectionState(
  card: AnthropicAccountCardView,
  state: AnthropicAccountState,
): ConnectionState {
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
        text: "Signed in to Cora only. Share it so Claude Code can use it too.",
      };
    case "terminal-only":
      // Nothing on this branch signs a managed profile in again; the only
      // way forward is a fresh add, so the line says so.
      if (card.terminal?.unsafe) {
        return {
          ok: false,
          text: "Claude Code cannot use this profile's folder. Delete it and add the account again.",
          danger: true,
        };
      }
      if (!card.terminal?.connected) {
        return {
          ok: false,
          text: "Not signed in to Claude Code. Delete it and add the account again.",
        };
      }
      return {
        ok: false,
        text: card.cliDefault
          ? "Signed in to Claude Code only, and the terminal is using it. Share it so Cora can use it too."
          : "Signed in to Claude Code only. Share it so Cora can use it too.",
      };
    case "account-one-signed-out":
      return {
        ok: false,
        text: terminalUsable(card)
          ? "Found your claude login. Cora is linking it now."
          : card.cora?.error
            ? `${card.cora.error} ${ACCOUNT_ONE_SIGNED_OUT_HINT}`
            : ACCOUNT_ONE_SIGNED_OUT_HINT,
      };
    case "active":
    case "signed-in":
      if (card.cora?.expired && card.cora.canRefresh) {
        return { ok: true, text: "Refreshing the Cora sign-in." };
      }
      if (card.terminal && !card.terminal.connected) {
        return {
          ok: true,
          text: "Signed in to Cora. The Claude Code copy is catching up.",
        };
      }
      return { ok: true, text: "Signed in to Cora and Claude Code." };
  }
}

function primaryAction(
  card: AnthropicAccountCardView,
  state: AnthropicAccountState,
  actions: AnthropicAccountActions,
  disabled: boolean,
): CardAction | undefined {
  switch (state) {
    case "active":
    case "account-one-signed-out":
      return undefined;
    case "signed-in":
      return {
        id: "use",
        label: "Use this account",
        disabled,
        run: () => actions.onUse(card),
      };
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
        label: "Share with Claude Code",
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

export default function AnthropicAccountCard({
  card,
  disabled,
  actions,
}: {
  card: AnthropicAccountCardView;
  /** The Pi runtime is missing or another account action is in flight. */
  disabled: boolean;
  actions: AnthropicAccountActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const brand = agentBrandColor("claude");
  const state = anthropicAccountState(card);
  const controlsDisabled = disabled || card.busy;
  const status = connectionState(card, state);
  const action = primaryAction(card, state, actions, controlsDisabled);
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
  // Account 1 is the user's own claude login: Codara never deletes it.
  if (renameable && !card.builtIn) {
    const closeCount = card.closeSessionsCount ?? 0;
    destructiveActions.push({
      id: "delete",
      label: deleteArmed
        ? closeCount > 0
          ? `Close ${closeCount} ${closeCount === 1 ? "session" : "sessions"} and delete`
          : "Confirm delete"
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

  return (
    <div
      aria-busy={card.busy || undefined}
      aria-current={card.active ? "true" : undefined}
      style={{
        display: "grid",
        gap: 10,
        padding: "12px 13px",
        borderRadius: "var(--radius-surface, 7px)",
        border: "1px solid var(--rule)",
        background: "var(--panel-2)",
        boxShadow: card.active ? `inset 2px 0 0 ${brand}` : "none",
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
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            flex: "0 0 auto",
          }}
        >
          {card.active ? <UsingChip label="Using" color={brand} /> : null}
          {card.busy ? (
            <span
              style={{
                color: "var(--muted)",
                fontFamily: "var(--font-sans)",
                fontSize: 10.5,
                lineHeight: 1.3,
                whiteSpace: "nowrap",
              }}
            >
              Working…
            </span>
          ) : action ? (
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
          {menuActions.length > 0 || destructiveActions.length > 0 ? (
            <CardOverflowMenu
              label={`More actions for ${card.label}`}
              groups={[menuActions, destructiveActions]}
              onClose={() => setDeleteArmed(false)}
            />
          ) : null}
        </span>
      </div>

      <ConnectionLine state={status} />

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
      ) : null}

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
  );
}
