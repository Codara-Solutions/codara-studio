// The title bar's usage panel: one surface, no flyout. Per provider, each
// limit as "now → at reset" (or when it runs out first) on a dot-and-circle
// track, the active account with a Switch menu, a nudge to another account
// only when a limit runs out and that account has room, and ChatGPT's banked
// resets with a confirm before one is spent. What it says comes from
// usage-glance.ts; who the accounts are from usage-roster.ts. DESIGN.md,
// "Usage in the title bar", has the rules.
//
// Escape peels one layer at a time: the Switch menu, the reset question,
// then the panel. It is taken in the capture phase so the terminal under
// the panel never sees it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  NativeCliAccountsInspection,
  PiSubscriptionOverview,
  PiSubscriptionProvider,
  PiUsageOverview,
} from "@shared/types";
import { formatClock, type UsageForecastReport } from "@shared/usage-forecast";
import { ClaudeMark, CodexMark, GrokMark } from "../BrandMarks";
import { openAccountsSettings } from "../chat/account-readiness";
import {
  expiryWords,
  glanceLimits,
  outlookEnd,
  percentText,
  planCodexReset,
  resetConfirmWords,
  switchSuggestion,
  type GlanceLimit,
} from "./usage-glance";
import {
  buildUsageRoster,
  formatPlan,
  formatResetDuration,
  tightestChip,
  type RosterAccount,
  type RosterProvider,
} from "./usage-roster";

const PANEL_WIDTH = 344;
const GAP = 6;
const EDGE = 8;

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: "drag" | "no-drag";
}

/** The provider marks from the Settings account cards, in currentColor. */
export function ProviderGlyph({ provider, size }: { provider: PiSubscriptionProvider; size?: number }) {
  if (provider === "anthropic") return <ClaudeMark size={size} />;
  if (provider === "openai-codex") return <CodexMark size={size} />;
  return <GrokMark size={size} />;
}

/** The subscription's name, as the user pays for it. */
export function providerName(provider: PiSubscriptionProvider): string {
  if (provider === "anthropic") return "Claude";
  if (provider === "openai-codex") return "ChatGPT";
  return "Grok";
}

function ChevronDown() {
  return (
    <svg width={9} height={9} viewBox="0 0 10 10" aria-hidden focusable="false">
      <path d="M3 4l2 2 2-2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^[A-Za-z]*Error:\s*/, "");
}

/** Ink while fine, warn past 70% used, danger only when it runs out. */
function nowTone(limit: GlanceLimit): string {
  if (limit.risk) return "var(--danger)";
  return limit.usedPercent >= 70 ? "var(--warn)" : "var(--ink)";
}

function trackTone(limit: GlanceLimit): string {
  if (limit.risk) return "var(--danger)";
  return limit.usedPercent >= 70 ? "var(--warn)" : "var(--ink-dim)";
}

function LimitRow({ limit, nowMs, forecastOn }: { limit: GlanceLimit; nowMs: number; forecastOn: boolean }) {
  const end = outlookEnd(limit);
  const tone = trackTone(limit);
  const reset = limit.resetsAtMs !== null ? formatClock(limit.resetsAtMs, nowMs) : null;
  const outlook = limit.outlook;
  let endCell: React.ReactNode = null;
  let endWords = "";
  if (outlook.kind === "end") {
    endCell = (
      <>
        {outlook.endPercent}%<small>at reset</small>
      </>
    );
    endWords = `ends around ${outlook.endPercent}% at reset`;
  } else if (outlook.kind === "out") {
    const at = formatClock(outlook.atMs, nowMs);
    const early = formatResetDuration(outlook.earlyMs);
    endCell = (
      <>
        out {at}
        <small>{early} early</small>
      </>
    );
    endWords = `runs out ${at}, ${early} before it resets`;
  } else if (outlook.kind === "used-up") {
    endCell = (
      <>
        used up<small>{reset ? `until ${reset}` : "until it resets"}</small>
      </>
    );
    endWords = "used up";
  } else if (outlook.kind === "no-history") {
    endCell = "not enough history yet";
    endWords = "not enough history yet to forecast";
  }
  const endClass =
    outlook.kind === "out" || outlook.kind === "used-up"
      ? " is-danger"
      : outlook.kind === "no-history"
        ? " is-none"
        : "";
  return (
    <div className="usage-limit" data-limit={limit.windowId} data-outlook={outlook.kind}>
      <span className="usage-limit__lab">
        {limit.title}
        {reset ? <small>resets {reset}</small> : null}
      </span>
      <span className="usage-limit__now" style={{ color: nowTone(limit) }}>
        {percentText(limit.usedPercent)}
      </span>
      <span className="usage-limit__arrow" aria-hidden>
        {forecastOn ? "→" : ""}
      </span>
      <span className={`usage-limit__end${endClass}`}>{endCell}</span>
      <span
        className="usage-limit__track"
        role="meter"
        aria-label={`${limit.title} limit used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(limit.usedPercent)}
        aria-valuetext={`${percentText(limit.usedPercent)} used${endWords ? `, ${endWords}` : ""}`}
      >
        {end !== null ? (
          <b className="usage-limit__ahead" style={{ width: `${end}%`, background: tone, opacity: limit.risk ? 0.45 : 0.28 }} />
        ) : null}
        <b style={{ width: `${limit.usedPercent}%`, background: tone }} />
        <i className="usage-limit__dot" style={{ left: `${Math.max(limit.usedPercent, 0.8)}%`, background: tone }} />
        {end !== null ? (
          <i className="usage-limit__ring" style={{ left: `${Math.min(end, 99.2)}%`, borderColor: tone }} />
        ) : null}
      </span>
    </div>
  );
}

function accountSub(account: RosterAccount): string | null {
  if (!account.active && account.blocked) return account.blocked;
  const tightest = tightestChip(account.chips);
  const used = tightest ? `${percentText(tightest.usedPercent)} used` : account.note;
  return [account.email, used].filter(Boolean).join(" · ") || null;
}

function SwitchMenu({
  entry,
  open,
  onOpen,
  busyKey,
  onSwitch,
}: {
  entry: RosterProvider;
  open: boolean;
  onOpen: (open: boolean) => void;
  busyKey: string | null;
  onSwitch: (account: RosterAccount) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("[role=menuitemradio]:not(:disabled)")?.focus();
  }, [open]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  };
  return (
    <span className="usage-switch">
      <button
        type="button"
        className="usage-switch__btn"
        data-switch-open={entry.provider}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Switch ${providerName(entry.provider)} account`}
        onClick={() => onOpen(!open)}
      >
        Switch <ChevronDown />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="usage-switch__menu"
          role="menu"
          aria-label={`${providerName(entry.provider)} accounts`}
          onKeyDown={onKeyDown}
        >
          {entry.accounts.map((account) => {
            const sub = accountSub(account);
            const disabled = !account.active && (account.action === null || busyKey !== null);
            return (
              <button
                key={account.key}
                type="button"
                role="menuitemradio"
                aria-checked={account.active}
                className={`usage-switch__item${account.active ? " is-active" : ""}`}
                data-account-key={account.key}
                disabled={disabled}
                title={
                  account.active
                    ? "New sessions use this account"
                    : account.system
                      ? "New sessions use your own login on this computer"
                      : undefined
                }
                onClick={() => (account.active ? onOpen(false) : onSwitch(account))}
              >
                <span className="usage-switch__text">
                  <span className="usage-switch__label">{account.label}</span>
                  {sub ? <span className="usage-switch__sub">{sub}</span> : null}
                </span>
                <span className="usage-switch__tag">
                  {account.active ? "Active" : busyKey === account.key ? "Switching…" : ""}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

const RESET_OUTCOME_TEXT: Record<string, string> = {
  reset: "Limits reset. The new figures load in a moment.",
  nothing_to_reset: "There was nothing to reset, so no reset was used.",
  no_credit: "This account has no resets left.",
  already_redeemed: "That reset was already used.",
};

function ResetBlock({
  entry,
  nowMs,
  confirming,
  onConfirm,
  busy,
  message,
  onReset,
}: {
  entry: RosterProvider;
  nowMs: number;
  confirming: boolean;
  onConfirm: (open: boolean) => void;
  busy: boolean;
  message: { text: string; danger: boolean } | null;
  onReset: (creditId: string | null) => void;
}) {
  const plan = planCodexReset(entry.usage, nowMs);
  if (!plan) return null;
  const words = resetConfirmWords(plan, entry.usage, providerName(entry.provider), nowMs);
  return (
    <div className="usage-resets" role="group" aria-label="Banked resets">
      <div className="usage-resets__hd">
        <span className="usage-resets__count">{plan.count}</span>
        <span className="usage-resets__lab">{plan.count === 1 ? "reset banked" : "resets banked"}</span>
      </div>
      {plan.credits.map((credit, index) => (
        <div
          key={credit.id ?? `credit-${index}`}
          className={`usage-credit${credit.soon ? " is-soon" : ""}`}
          data-credit-id={credit.id ?? undefined}
        >
          <span className="usage-credit__dot" aria-hidden />
          <span className="usage-credit__when">
            {credit.expiresAtMs !== null ? `Expires ${expiryWords(credit.expiresAtMs, nowMs)}` : "No expiry given"}
          </span>
          {credit.expiresAtMs !== null ? (
            <span className="usage-credit__in">in {formatResetDuration(credit.expiresAtMs - nowMs)}</span>
          ) : null}
        </div>
      ))}
      {confirming && plan.canUse ? (
        <div className="usage-resets__confirm" role="group" aria-label="Confirm reset">
          <span className="usage-resets__q">{words.question}</span>
          <span className="usage-resets__d">{words.detail}</span>
          <span className="usage-resets__btns">
            <button type="button" className="spark-btn" disabled={busy} onClick={() => onConfirm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="spark-btn is-primary"
              data-reset-confirm
              disabled={busy}
              onClick={() => onReset(plan.next?.id ?? null)}
            >
              {busy ? "Using…" : "Use reset"}
            </button>
          </span>
        </div>
      ) : (
        <div className="usage-resets__act">
          <button
            type="button"
            className="spark-btn"
            data-reset-open
            disabled={!plan.canUse}
            onClick={() => onConfirm(true)}
          >
            Use a reset
          </button>
          {plan.why ? <span className="usage-resets__note">{plan.why}</span> : null}
        </div>
      )}
      {message ? (
        <span className={`usage-resets__msg${message.danger ? " is-danger" : ""}`} role="status">
          {message.text}
        </span>
      ) : null}
    </div>
  );
}

/** A provider with nothing to draw, as one line: what it says, and Connect
 * when signing in is what would make limits appear. */
function ProviderLine({ entry, onConnect }: { entry: RosterProvider; onConnect: () => void }) {
  const status = entry.status ?? "No limits reported";
  const reading = entry.usage?.status;
  const connect =
    !entry.active ||
    (entry.active.system && entry.active.profileId !== null && entry.active.chips.length === 0 && entry.usage?.status !== "ok") ||
    reading === "not_connected" ||
    reading === "expired";
  return (
    <div className="usage-line" data-provider={entry.provider}>
      <span className="usage-line__mark" aria-hidden>
        <ProviderGlyph provider={entry.provider} size={12} />
      </span>
      <span className="usage-line__text">
        {providerName(entry.provider)}: {status.charAt(0).toLowerCase() + status.slice(1)}
      </span>
      {connect ? (
        <button type="button" className="usage-line__act" onClick={onConnect}>
          Connect
        </button>
      ) : null}
    </div>
  );
}

export interface UsagePanelProps {
  /** The hairline (or hairline group) it opened from; the panel hangs under it. */
  anchor: DOMRect;
  usage: PiUsageOverview | null;
  usageLoading: boolean;
  accounts: PiSubscriptionOverview | null;
  cli: NativeCliAccountsInspection | null;
  forecast: UsageForecastReport | null;
  forecastOn: boolean;
  onAccounts: (overview: PiSubscriptionOverview) => void;
  /** Closes the panel; restoreFocus returns focus to the hairline. */
  onClose: (restoreFocus: boolean) => void;
  /** Elements that count as inside for click-away (the hairlines). */
  ownerRef: React.RefObject<HTMLElement | null>;
  onOpenUsage?: () => void;
}

interface SwitchState {
  provider: PiSubscriptionProvider;
  key: string;
  error?: string;
}

export default function UsagePanel({
  anchor,
  usage,
  usageLoading,
  accounts,
  cli,
  forecast,
  forecastOn,
  onAccounts,
  onClose,
  ownerRef,
  onOpenUsage,
}: UsagePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [menu, setMenu] = useState<PiSubscriptionProvider | null>(null);
  const [switching, setSwitching] = useState<SwitchState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMessage, setResetMessage] = useState<{ text: string; danger: boolean } | null>(null);

  // Providers with limits first, in the Accounts order; the rest as lines.
  const roster = useMemo(() => {
    const entries = buildUsageRoster({ usage, accounts, cli, usageLoading });
    return [...entries.filter((entry) => entry.windows.length > 0), ...entries.filter((entry) => entry.windows.length === 0)];
  }, [usage, accounts, cli, usageLoading]);

  // Countdowns stay true while the panel is open.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setNowMs(Date.now()), [usage, forecast]);

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const closeMenu = useCallback((provider: PiSubscriptionProvider | null) => {
    setMenu(null);
    if (!provider) return;
    window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>(`[data-switch-open="${provider}"]`)?.focus();
    });
  }, []);

  const menuRef = useRef(menu);
  menuRef.current = menu;
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;
  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      Boolean(panelRef.current?.contains(target) || ownerRef.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) onClose(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event.target)) onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (menuRef.current) {
        closeMenu(menuRef.current);
        return;
      }
      if (confirmingRef.current) {
        setConfirming(false);
        window.requestAnimationFrame(() => {
          panelRef.current?.querySelector<HTMLElement>("[data-reset-open]")?.focus();
        });
        return;
      }
      onClose(true);
    };
    const onResize = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [closeMenu, onClose, ownerRef]);

  // Clicking inside the panel but outside an open Switch menu closes the menu.
  const onPanelPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!menu) return;
    const target = event.target as HTMLElement;
    if (!target.closest(".usage-switch")) setMenu(null);
  };

  const switchTo = (entry: RosterProvider, account: RosterAccount) => {
    // One switch at a time; a failed one can be retried.
    if (switching !== null && switching.error === undefined) return;
    const provider = entry.provider;
    const request =
      account.action === "use-system"
        ? window.spark.piSubscriptions.useSystemLogin(provider)
        : account.profileId
          ? window.spark.piSubscriptions.makeDefault({ provider, profileId: account.profileId })
          : null;
    if (!request) return;
    setSwitching({ provider, key: account.key });
    request
      .then((overview) => {
        onAccounts(overview);
        setSwitching(null);
        closeMenu(provider);
      })
      .catch((error) => {
        setSwitching({ provider, key: account.key, error: ipcErrorMessage(error) });
      });
  };

  const redeemReset = (entry: RosterProvider, creditId: string | null) => {
    const profileId = entry.active?.profileId;
    if (!profileId || resetBusy) return;
    setResetBusy(true);
    setResetMessage(null);
    window.spark.piSubscriptions
      .redeemCodexReset(profileId, creditId ?? undefined)
      .then((result) => {
        setResetMessage({
          text: RESET_OUTCOME_TEXT[result.outcome] ?? "The reset was sent.",
          danger: result.outcome !== "reset",
        });
      })
      .catch((error) => setResetMessage({ text: ipcErrorMessage(error), danger: true }))
      .finally(() => {
        setResetBusy(false);
        setConfirming(false);
        window.requestAnimationFrame(() => {
          (panelRef.current?.querySelector<HTMLElement>("[data-reset-open]") ?? panelRef.current)?.focus();
        });
      });
  };

  useEffect(() => {
    if (!confirming) return;
    panelRef.current?.querySelector<HTMLElement>("[data-reset-confirm]")?.focus();
  }, [confirming]);

  const openAccounts = () => {
    onClose(false);
    openAccountsSettings();
  };

  const left = Math.min(
    Math.max(EDGE, anchor.right - PANEL_WIDTH),
    Math.max(EDGE, window.innerWidth - PANEL_WIDTH - EDGE),
  );
  const top = anchor.bottom + GAP;

  return (
    <div
      ref={panelRef}
      className="spark-menu usage-pop"
      role="dialog"
      aria-label="Usage"
      tabIndex={-1}
      onPointerDown={onPanelPointerDown}
      style={
        {
          top,
          left,
          width: PANEL_WIDTH,
          maxHeight: `calc(100vh - ${top + EDGE}px)`,
          WebkitAppRegion: "no-drag",
        } as AppRegionStyle
      }
    >
      {roster.length === 0 ? (
        <p className="usage-pop__empty">{usageLoading ? "Checking limits…" : "No accounts yet. Add one in Accounts."}</p>
      ) : null}
      {roster.map((entry) => {
        if (entry.windows.length === 0) {
          return <ProviderLine key={entry.provider} entry={entry} onConnect={openAccounts} />;
        }
        const limits = glanceLimits(entry.usage, forecast, forecastOn);
        const suggestion = switchSuggestion(entry, limits);
        // A Switch menu only when there is somewhere to switch to.
        const several = entry.accounts.some((account) => !account.active && account.action !== null);
        const plan = formatPlan(entry.usage?.plan);
        const switchError = switching?.provider === entry.provider ? switching.error : undefined;
        const busyKey =
          switching?.provider === entry.provider && switching.error === undefined ? switching.key : null;
        return (
          <section
            key={entry.provider}
            className="usage-prov"
            data-provider={entry.provider}
            aria-label={`${providerName(entry.provider)} usage`}
          >
            <div className="usage-prov__hd">
              <span className="usage-prov__mark" aria-hidden>
                <ProviderGlyph provider={entry.provider} size={13} />
              </span>
              <span className="usage-prov__name">{providerName(entry.provider)}</span>
              <span className="usage-prov__acct">{several ? entry.active?.label : (plan ?? entry.active?.label)}</span>
              <span className="usage-prov__right">
                {several ? (
                  <SwitchMenu
                    entry={entry}
                    open={menu === entry.provider}
                    onOpen={(open) => (open ? setMenu(entry.provider) : closeMenu(entry.provider))}
                    busyKey={busyKey}
                    onSwitch={(account) => switchTo(entry, account)}
                  />
                ) : entry.active?.email ? (
                  <span className="usage-prov__email">{entry.active.email}</span>
                ) : null}
              </span>
            </div>
            <div className="usage-limit usage-limit--head" aria-hidden>
              <span />
              <span className="usage-limit__now">now</span>
              <span />
              <span className="usage-limit__end">{forecastOn ? "at reset" : ""}</span>
            </div>
            {limits.map((limit) => (
              <LimitRow key={limit.windowId} limit={limit} nowMs={nowMs} forecastOn={forecastOn} />
            ))}
            {suggestion ? (
              <div className="usage-nudge" role="status">
                <span className="usage-nudge__text">
                  <b>
                    {suggestion.account.label} has {suggestion.leftPercent}% left.
                  </b>{" "}
                  <span>Use it for new sessions.</span>
                </span>
                <button
                  type="button"
                  className="spark-btn is-primary"
                  data-nudge-switch
                  disabled={busyKey !== null}
                  onClick={() => switchTo(entry, suggestion.account)}
                >
                  {busyKey === suggestion.account.key ? "Switching…" : "Switch"}
                </button>
              </div>
            ) : null}
            {switchError ? (
              <span className="usage-prov__error" role="alert">
                {switchError}
              </span>
            ) : null}
            {entry.provider === "openai-codex" && entry.active?.profileId ? (
              <ResetBlock
                entry={entry}
                nowMs={nowMs}
                confirming={confirming}
                onConfirm={(open) => {
                  setResetMessage(null);
                  setConfirming(open);
                  if (!open) {
                    window.requestAnimationFrame(() => {
                      panelRef.current?.querySelector<HTMLElement>("[data-reset-open]")?.focus();
                    });
                  }
                }}
                busy={resetBusy}
                message={resetMessage}
                onReset={(creditId) => redeemReset(entry, creditId)}
              />
            ) : null}
          </section>
        );
      })}
      <div className="usage-pop__foot">
        {onOpenUsage ? (
          <button
            type="button"
            className="usage-pop__link"
            onClick={() => {
              onClose(false);
              onOpenUsage();
            }}
          >
            Usage details
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="usage-pop__link" onClick={openAccounts}>
          Accounts
        </button>
      </div>
    </div>
  );
}
