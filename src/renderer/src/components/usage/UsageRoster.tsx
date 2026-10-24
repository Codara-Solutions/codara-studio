// The title bar's Usage panel: one row per provider with the limits of the
// account new sessions use, and beside it a flyout with everything known
// about that provider (every window, credits, resets, and every account with
// its email and limits). Modelled on Orca's usage roster
// (github.com/stablyai/orca, MIT); the rules live in usage-roster.ts.
//
// Both surfaces are menu glass, side by side and never stacked. Keys: the
// arrows move through rows, Right or Enter opens a row's flyout, Left closes
// it, and Escape peels one layer at a time.

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  NativeCliAccountsInspection,
  PiSubscriptionOverview,
  PiSubscriptionProvider,
  PiUsageOverview,
  PiUsageWindow,
} from "@shared/types";
import { ClaudeMark, CodexMark, GrokMark } from "../BrandMarks";
import { ReloadIcon } from "../icons";
import { openAccountsSettings } from "../chat/account-readiness";
import type { UsageForecastReport, WindowForecastView } from "@shared/usage-forecast";
import { ForecastGhost, ForecastLine } from "./UsageForecast";
import { forecastFor, useForecastStyle, type ForecastPanelStyle } from "./useUsageForecast";
import {
  buildUsageRoster,
  describeCredits,
  describeResetCredits,
  formatResetsIn,
  formatUpdatedAgo,
  resetWorthSpending,
  soonestReset,
  tightestChip,
  usageTone,
  windowTitle,
  type RosterAccount,
  type RosterChip,
  type RosterProvider,
  type UsageDensity,
} from "./usage-roster";

const ROSTER_WIDTH = 340;
const FLYOUT_WIDTH = 300;
const GAP = 6;
const EDGE = 8;

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: "drag" | "no-drag";
}

/** The provider marks from the Settings account cards, in currentColor. */
export function ProviderGlyph({
  provider,
  size,
}: {
  provider: PiSubscriptionProvider;
  size?: number;
}) {
  if (provider === "anthropic") return <ClaudeMark size={size} />;
  if (provider === "openai-codex") return <CodexMark size={size} />;
  return <GrokMark size={size} />;
}

function ChevronGlyph() {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden focusable="false">
      <path
        d="M3.5 2 6.5 5 3.5 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^[A-Za-z]*Error:\s*/, "");
}

function percentText(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}

/** A thin bar; a sliver stays visible so 0.4% reads as started. */
function Bar({ usedPercent, className }: { usedPercent: number; className: string }) {
  return (
    <span className={className} aria-hidden>
      <span
        style={{
          width: `${Math.max(usedPercent, usedPercent > 0 ? 3 : 0)}%`,
          background: usageTone(usedPercent),
        }}
      />
    </span>
  );
}

function Chip({ chip, bar }: { chip: RosterChip; bar: boolean }) {
  return (
    <span className="usage-chip">
      <span className="usage-chip__label">{chip.label}</span>
      {bar ? <Bar usedPercent={chip.usedPercent} className="usage-chip__bar" /> : null}
      <span className="usage-chip__pct" style={{ color: usageTone(chip.usedPercent) }}>
        {percentText(chip.usedPercent)}
      </span>
    </span>
  );
}

function chipsSpeech(chips: readonly RosterChip[]): string {
  return chips.map((chip) => `${chip.label} ${percentText(chip.usedPercent)} used`).join(", ");
}

function accountLine(account: RosterAccount | null): string | null {
  if (!account) return null;
  return account.email ? `${account.label} · ${account.email}` : account.label;
}

function RosterRow({
  entry,
  density,
  nowMs,
  open,
  flyoutId,
  onOpen,
}: {
  entry: RosterProvider;
  density: UsageDensity;
  nowMs: number;
  open: boolean;
  flyoutId: string;
  onOpen: (provider: PiSubscriptionProvider, focusInside: boolean) => void;
}) {
  const compact = density === "compact";
  const tightest = tightestChip(entry.chips);
  const reset = soonestReset(compact && tightest ? [tightest] : entry.chips, nowMs);
  const account = accountLine(entry.active);
  const speech = [
    entry.name,
    entry.plan ? `${entry.plan} plan` : null,
    entry.chips.length > 0
      ? chipsSpeech(compact && tightest ? [tightest] : entry.chips)
      : entry.status,
    reset,
    account ? `Active: ${account}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      className={`usage-roster-row${open ? " is-open" : ""}`}
      data-roster-nav
      data-provider={entry.provider}
      aria-label={speech}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? flyoutId : undefined}
      onClick={(event) => onOpen(entry.provider, event.detail === 0)}
    >
      <span className="usage-roster-row__mark" aria-hidden>
        <ProviderGlyph provider={entry.provider} size={14} />
      </span>
      <span className="usage-roster-row__body">
        <span className="usage-roster-row__head">
          <span className="usage-roster-row__name">{entry.name}</span>
          {entry.plan ? <span className="usage-roster-row__plan">{entry.plan}</span> : null}
          {compact && tightest ? <Chip chip={tightest} bar={false} /> : null}
          {compact && !tightest && entry.status ? (
            <span className="usage-roster-row__status">{entry.status}</span>
          ) : null}
          <span className="usage-roster-row__reset">{reset ?? ""}</span>
        </span>
        {!compact && entry.chips.length > 0 ? (
          <span className="usage-roster-row__chips">
            {entry.chips.map((chip) => (
              <Chip key={chip.id} chip={chip} bar />
            ))}
          </span>
        ) : null}
        {!compact && entry.chips.length === 0 && entry.status ? (
          <span className="usage-roster-row__status">{entry.status}</span>
        ) : null}
        {!compact && account ? (
          <span className="usage-roster-row__account">{account}</span>
        ) : null}
      </span>
      <span className="usage-roster-row__chev" aria-hidden>
        <ChevronGlyph />
      </span>
    </button>
  );
}

function WindowSection({
  window: usageWindow,
  nowMs,
  forecast = null,
  forecastStyle = "line",
}: {
  window: PiUsageWindow;
  nowMs: number;
  forecast?: WindowForecastView | null;
  forecastStyle?: ForecastPanelStyle;
}) {
  const used = Math.min(100, Math.max(0, usageWindow.usedPercent));
  const resets =
    formatResetsIn(usageWindow.resetsAt, nowMs) ??
    (usageWindow.resetsIn ? `Resets in ${usageWindow.resetsIn}` : null);
  const title = windowTitle(usageWindow);
  return (
    <div className="usage-window">
      <div className="usage-window__head">
        <span className="usage-window__title">{title}</span>
        <span className="usage-window__pct">{percentText(used)} used</span>
      </div>
      <div
        role="meter"
        aria-label={`${title} limit used`}
        aria-valuenow={Math.round(used)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="usage-window__meter"
      >
        <Bar usedPercent={used} className="usage-window__bar" />
        {forecast && forecastStyle === "ghost" ? <ForecastGhost view={forecast} /> : null}
      </div>
      {resets ? <span className="usage-window__reset">{resets}</span> : null}
      {forecast ? <ForecastLine view={forecast} compact={forecastStyle !== "line"} /> : null}
    </div>
  );
}

const RESET_OUTCOME_TEXT: Record<string, string> = {
  reset: "Limits reset. The new figures load in a moment.",
  nothing_to_reset: "There was nothing to reset, so no reset was used.",
  no_credit: "This account has no resets left.",
  already_redeemed: "That reset was already used.",
};

interface SwitchState {
  key: string;
  error?: string;
}

function AccountItem({
  account,
  busy,
  disabled,
  onSwitch,
}: {
  account: RosterAccount;
  busy: boolean;
  disabled: boolean;
  onSwitch: (account: RosterAccount) => void;
}) {
  const label = account.email ? `${account.label}, ${account.email}` : account.label;
  return (
    <div
      role="listitem"
      className={`usage-account${account.active ? " is-active" : ""}`}
      aria-label={account.active ? `${label}, Active` : label}
    >
      <div className="usage-account__line">
        <span className="usage-account__text">
          <span className="usage-account__label">{account.label}</span>
          {account.email ? <span className="usage-account__email">{account.email}</span> : null}
        </span>
        {account.active ? (
          <span className="usage-account__tag">Active</span>
        ) : account.action ? (
          <button
            type="button"
            className="spark-btn usage-account__switch"
            data-flyout-nav
            data-account-key={account.key}
            aria-label={`Switch to ${account.label}`}
            title={
              account.system
                ? "New sessions use your own login on this computer"
                : "New sessions use this account"
            }
            disabled={disabled}
            onClick={() => onSwitch(account)}
          >
            {busy ? "Switching…" : "Switch"}
          </button>
        ) : null}
      </div>
      {account.chips.length > 0 ? (
        <span className="usage-account__chips">
          {account.chips.map((chip) => (
            <Chip key={chip.id} chip={chip} bar />
          ))}
        </span>
      ) : account.note ? (
        <span className="usage-account__note">{account.note}</span>
      ) : null}
      {!account.active && account.blocked ? (
        <span className="usage-account__note">{account.blocked}</span>
      ) : null}
    </div>
  );
}

function ProviderFlyout({
  entry,
  id,
  nowMs,
  style,
  flyoutRef,
  onKeyDown,
  switching,
  onSwitch,
  confirming,
  onConfirm,
  resetBusy,
  resetMessage,
  onReset,
  onManageAccounts,
  forecast,
}: {
  entry: RosterProvider;
  id: string;
  nowMs: number;
  style: React.CSSProperties;
  flyoutRef: React.RefObject<HTMLDivElement>;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  switching: SwitchState | null;
  onSwitch: (account: RosterAccount) => void;
  confirming: boolean;
  onConfirm: (open: boolean) => void;
  resetBusy: boolean;
  resetMessage: { text: string; danger: boolean } | null;
  onReset: () => void;
  onManageAccounts: () => void;
  forecast: UsageForecastReport | null;
}) {
  const usage = entry.usage;
  const forecastStyle = useForecastStyle();
  const nextAccount =
    entry.provider === "anthropic" || entry.provider === "openai-codex"
      ? (forecast?.nextAccount[entry.provider] ?? null)
      : null;
  const updated = usage?.status === "ok" ? formatUpdatedAgo(usage.checkedAt, nowMs) : null;
  const credits = describeCredits(usage?.credits);
  const resets = describeResetCredits(usage, nowMs);
  const worthSpending = resetWorthSpending(usage);
  const activeLine = accountLine(entry.active);
  const switchBusy = switching !== null && switching.error === undefined;
  return (
    <div
      ref={flyoutRef}
      id={id}
      className="spark-menu usage-flyout"
      role="dialog"
      aria-label={`${entry.name} usage`}
      onKeyDown={onKeyDown}
      style={style}
    >
      <div className="usage-flyout__head">
        <span className="usage-flyout__mark" aria-hidden>
          <ProviderGlyph provider={entry.provider} size={14} />
        </span>
        <span className="usage-flyout__name">{entry.name}</span>
        {entry.plan ? <span className="usage-roster-row__plan">{entry.plan}</span> : null}
        <span className="usage-flyout__updated">{updated ?? ""}</span>
      </div>
      {activeLine ? (
        <div className="usage-flyout__active">
          <span className="usage-flyout__active-label">Active</span>
          <span className="usage-flyout__active-name">{activeLine}</span>
        </div>
      ) : null}

      {entry.windows.length > 0 ? (
        <div className="usage-flyout__windows">
          {entry.windows.map((usageWindow) => (
            <WindowSection
              key={usageWindow.id}
              window={usageWindow}
              nowMs={nowMs}
              forecast={forecastFor(forecast, usage?.profileId, usageWindow.id)}
              forecastStyle={forecastStyle}
            />
          ))}
        </div>
      ) : entry.detail ? (
        <p className="usage-flyout__detail">{entry.detail}</p>
      ) : null}

      {usage?.limitReached ? (
        <p className="usage-flyout__alert" role="status">
          {usage.generalLimitReached
            ? "Limit reached. New requests are refused until it resets."
            : "A model limit is reached. Other models still work."}
        </p>
      ) : null}

      {credits ? (
        <div className="usage-flyout__section">
          <span className="usage-flyout__section-title">{credits.title}</span>
          <span className="usage-flyout__line">{credits.line}</span>
          {credits.usedPercent !== null ? (
            <Bar usedPercent={credits.usedPercent} className="usage-window__bar" />
          ) : null}
        </div>
      ) : null}

      {resets && entry.active?.profileId ? (
        <div className="usage-flyout__section">
          <span className="usage-flyout__section-title">Rate-limit resets</span>
          <span className="usage-flyout__line">{resets.line}</span>
          {resets.expiry ? <span className="usage-flyout__muted">{resets.expiry}</span> : null}
          {confirming ? (
            <div className="usage-flyout__confirm" role="group" aria-label="Confirm reset">
              <span className="usage-flyout__line">
                Use one reset on {entry.active.label}? Your {entry.name} limits clear now, and
                the reset cannot be given back.
              </span>
              <span className="usage-flyout__actions">
                <button
                  type="button"
                  className="spark-btn is-primary"
                  data-flyout-nav
                  data-reset-confirm
                  disabled={resetBusy}
                  onClick={onReset}
                >
                  {resetBusy ? "Resetting…" : "Reset now"}
                </button>
                <button
                  type="button"
                  className="spark-btn"
                  data-flyout-nav
                  disabled={resetBusy}
                  onClick={() => onConfirm(false)}
                >
                  Cancel
                </button>
              </span>
            </div>
          ) : (
            <span className="usage-flyout__actions">
              <button
                type="button"
                className="spark-btn"
                data-flyout-nav
                data-reset-open
                disabled={!worthSpending}
                title={worthSpending ? undefined : "Nothing to reset yet"}
                onClick={() => onConfirm(true)}
              >
                Reset now
              </button>
              {!worthSpending ? (
                <span className="usage-flyout__muted">Nothing to reset yet</span>
              ) : null}
            </span>
          )}
          {resetMessage ? (
            <span
              className={`usage-flyout__line${resetMessage.danger ? " is-danger" : ""}`}
              role="status"
            >
              {resetMessage.text}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="usage-flyout__section">
        <span className="usage-flyout__section-title" id={`${id}-accounts`}>
          {entry.cliLabel} accounts
        </span>
        <div role="list" aria-labelledby={`${id}-accounts`} className="usage-flyout__accounts">
          {entry.accounts.map((account) => (
            <AccountItem
              key={account.key}
              account={account}
              busy={switching?.key === account.key && switching.error === undefined}
              disabled={switchBusy}
              onSwitch={onSwitch}
            />
          ))}
        </div>
        {nextAccount ? <span className="usage-forecast__extra">{nextAccount}</span> : null}
        {switching?.error ? (
          <span className="usage-flyout__line is-danger" role="alert">
            {switching.error}
          </span>
        ) : null}
      </div>

      <div className="usage-flyout__foot">
        <button
          type="button"
          className="spark-menu-item"
          data-flyout-nav
          onClick={onManageAccounts}
        >
          Manage Accounts…
        </button>
      </div>
    </div>
  );
}

export interface UsageRosterProps {
  /** The pill (or pill group) it opened from; the panel hangs under it. */
  anchor: DOMRect;
  usage: PiUsageOverview | null;
  usageLoading: boolean;
  accounts: PiSubscriptionOverview | null;
  cli: NativeCliAccountsInspection | null;
  refreshing: boolean;
  density: UsageDensity;
  onDensity: (density: UsageDensity) => void;
  /** The row focused on open. */
  focusProvider: PiSubscriptionProvider | null;
  onRefresh: () => void;
  onAccounts: (overview: PiSubscriptionOverview) => void;
  /** Closes the panel; restoreFocus returns focus to the pill. */
  onClose: (restoreFocus: boolean) => void;
  /** Elements that count as inside for click-away (the pills). */
  ownerRef: React.RefObject<HTMLElement | null>;
  onOpenUsage?: () => void;
  /** Labs: the usage forecast, null while it is off. */
  forecast?: UsageForecastReport | null;
}

function navItems(root: HTMLElement | null, attribute: string): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(`[${attribute}]`)).filter(
    (element) => !(element as HTMLButtonElement).disabled,
  );
}

function moveFocus(items: HTMLElement[], key: string): boolean {
  if (items.length === 0) return false;
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % items.length;
  else if (key === "ArrowUp") next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
  else if (key === "Home") next = 0;
  else if (key === "End") next = items.length - 1;
  else return false;
  items[next].focus();
  return true;
}

export default function UsageRoster({
  anchor,
  usage,
  usageLoading,
  accounts,
  cli,
  refreshing,
  density,
  onDensity,
  focusProvider,
  onRefresh,
  onAccounts,
  onClose,
  ownerRef,
  onOpenUsage,
  forecast = null,
}: UsageRosterProps) {
  const rosterRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutId = useId();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [flyout, setFlyout] = useState<PiSubscriptionProvider | null>(null);
  const [flyoutStyle, setFlyoutStyle] = useState<{ top: number; left: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMessage, setResetMessage] = useState<{ text: string; danger: boolean } | null>(null);
  const [switching, setSwitching] = useState<SwitchState | null>(null);
  const focusFlyoutRef = useRef(false);

  const roster = useMemo(
    () => buildUsageRoster({ usage, accounts, cli, usageLoading }),
    [usage, accounts, cli, usageLoading],
  );
  const flyoutEntry = roster.find((entry) => entry.provider === flyout) ?? null;

  // Countdowns and "Updated 2m ago" stay true while the panel is open.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setNowMs(Date.now()), [usage]);

  const closeFlyout = useCallback((focusRow: boolean) => {
    setFlyout((current) => {
      if (focusRow && current) {
        window.requestAnimationFrame(() => {
          rosterRef.current
            ?.querySelector<HTMLElement>(`[data-provider="${current}"]`)
            ?.focus();
        });
      }
      return null;
    });
    setConfirming(false);
    setResetMessage(null);
    setSwitching(null);
  }, []);

  const openFlyout = useCallback(
    (provider: PiSubscriptionProvider, focusInside: boolean) => {
      if (flyout === provider) {
        if (!focusInside) {
          closeFlyout(false);
          return;
        }
        (navItems(flyoutRef.current, "data-flyout-nav")[0] ?? flyoutRef.current)?.focus();
        return;
      }
      focusFlyoutRef.current = focusInside;
      setFlyout(provider);
      setConfirming(false);
      setResetMessage(null);
      setSwitching(null);
    },
    [closeFlyout, flyout],
  );

  // Focus lands on the row the panel was opened for, so the arrows work at once.
  useEffect(() => {
    const rows = navItems(rosterRef.current, "data-roster-nav");
    const target =
      (focusProvider &&
        rosterRef.current?.querySelector<HTMLElement>(`[data-provider="${focusProvider}"]`)) ||
      rows[0] ||
      rosterRef.current;
    target?.focus({ preventScroll: true });
    // Only on open: later reads must not pull focus away from where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The flyout sits beside its row: to the right when it fits, else to the
  // left, and moved up when it would run off the bottom.
  useLayoutEffect(() => {
    if (!flyout) {
      setFlyoutStyle(null);
      return;
    }
    const roster = rosterRef.current?.getBoundingClientRect();
    const row = rosterRef.current
      ?.querySelector<HTMLElement>(`[data-provider="${flyout}"]`)
      ?.getBoundingClientRect();
    if (!roster || !row) return;
    const height = flyoutRef.current?.offsetHeight ?? 0;
    const fitsRight = roster.right + GAP + FLYOUT_WIDTH <= window.innerWidth - EDGE;
    const left = fitsRight
      ? roster.right + GAP
      : Math.max(EDGE, roster.left - GAP - FLYOUT_WIDTH);
    const top = Math.max(EDGE, Math.min(row.top - 4, window.innerHeight - EDGE - height));
    setFlyoutStyle((current) =>
      current && current.top === top && current.left === left ? current : { top, left },
    );
  });

  useEffect(() => {
    if (!flyoutStyle || !focusFlyoutRef.current) return;
    focusFlyoutRef.current = false;
    const first = navItems(flyoutRef.current, "data-flyout-nav")[0] ?? flyoutRef.current;
    first?.focus({ preventScroll: true });
  }, [flyoutStyle]);

  // Click-away and Escape. Escape is taken in the capture phase and stopped,
  // so the terminal underneath never sees it, and it peels one layer: the
  // reset question, then the flyout, then the panel.
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;
  const flyoutOpenRef = useRef(flyout);
  flyoutOpenRef.current = flyout;
  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      Boolean(
        rosterRef.current?.contains(target) ||
          flyoutRef.current?.contains(target) ||
          ownerRef.current?.contains(target),
      );
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
      if (confirmingRef.current) {
        setConfirming(false);
        window.requestAnimationFrame(() => {
          flyoutRef.current?.querySelector<HTMLElement>("[data-reset-open]")?.focus();
        });
        return;
      }
      if (flyoutOpenRef.current) {
        closeFlyout(true);
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
  }, [closeFlyout, onClose, ownerRef]);

  const onRosterKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === "ArrowRight" && target.matches("[data-provider]")) {
      event.preventDefault();
      openFlyout(target.dataset.provider as PiSubscriptionProvider, true);
      return;
    }
    if (event.key === "ArrowLeft" && flyout) {
      event.preventDefault();
      closeFlyout(true);
      return;
    }
    if (target.closest(".spark-segmented") && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      return;
    }
    if (moveFocus(navItems(rosterRef.current, "data-roster-nav"), event.key)) {
      event.preventDefault();
    }
  };

  const onFlyoutKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      closeFlyout(true);
      return;
    }
    if (moveFocus(navItems(flyoutRef.current, "data-flyout-nav"), event.key)) {
      event.preventDefault();
    }
  };

  const switchTo = (account: RosterAccount) => {
    // One switch at a time; a failed one can be retried.
    if (!flyoutEntry || (switching !== null && switching.error === undefined)) return;
    const provider = flyoutEntry.provider;
    setSwitching({ key: account.key });
    const request =
      account.action === "use-system"
        ? window.spark.piSubscriptions.useSystemLogin(provider)
        : account.profileId
          ? window.spark.piSubscriptions.makeDefault({ provider, profileId: account.profileId })
          : null;
    if (!request) {
      setSwitching(null);
      return;
    }
    request
      .then((overview) => {
        onAccounts(overview);
        setSwitching(null);
        // The button that had focus is gone once its account is Active.
        window.requestAnimationFrame(() => {
          if (flyoutRef.current?.contains(document.activeElement)) return;
          (navItems(flyoutRef.current, "data-flyout-nav")[0] ?? null)?.focus();
        });
      })
      .catch((error) => {
        setSwitching({ key: account.key, error: ipcErrorMessage(error) });
        window.requestAnimationFrame(() => {
          flyoutRef.current
            ?.querySelector<HTMLElement>(`[data-account-key="${CSS.escape(account.key)}"]`)
            ?.focus();
        });
      });
  };

  const manageAccounts = () => {
    onClose(false);
    openAccountsSettings();
  };

  const redeemReset = () => {
    const profileId = flyoutEntry?.active?.profileId;
    if (!profileId || resetBusy) return;
    setResetBusy(true);
    setResetMessage(null);
    window.spark.piSubscriptions
      .redeemCodexReset(profileId)
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
          (
            flyoutRef.current?.querySelector<HTMLElement>("[data-reset-open]") ??
            flyoutRef.current
          )?.focus();
        });
      });
  };

  // Confirming moves focus to the question's first button.
  useEffect(() => {
    if (!confirming) return;
    flyoutRef.current?.querySelector<HTMLElement>("[data-reset-confirm]")?.focus();
  }, [confirming]);

  const left = Math.min(
    Math.max(EDGE, anchor.right - ROSTER_WIDTH),
    Math.max(EDGE, window.innerWidth - ROSTER_WIDTH - EDGE),
  );
  const top = anchor.bottom + GAP;

  return (
    <>
      <div
        ref={rosterRef}
        className="spark-menu usage-roster"
        role="dialog"
        aria-label="Usage"
        tabIndex={-1}
        onKeyDown={onRosterKeyDown}
        style={
          {
            top,
            left,
            width: ROSTER_WIDTH,
            maxHeight: `calc(100vh - ${top + EDGE}px)`,
            WebkitAppRegion: "no-drag",
          } as AppRegionStyle
        }
      >
        <div className="usage-roster__head">
          <span className="usage-roster__title">Usage</span>
          <span className="usage-roster__sub">all agents</span>
          <span className="spark-segmented usage-roster__density" role="group" aria-label="Density">
            {(["detailed", "compact"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`spark-segmented-item${density === option ? " is-selected" : ""}`}
                aria-pressed={density === option}
                onClick={() => onDensity(option)}
              >
                {option === "detailed" ? "Detailed" : "Compact"}
              </button>
            ))}
          </span>
          <button
            type="button"
            className="spark-icon-btn usage-roster__refresh"
            aria-label="Refresh usage"
            title="Refresh usage"
            aria-busy={refreshing}
            aria-disabled={refreshing}
            onClick={() => {
              if (!refreshing) onRefresh();
            }}
          >
            <span className={refreshing ? "usage-roster__spin" : undefined}>
              <ReloadIcon size={12} />
            </span>
          </button>
        </div>

        <div className="usage-roster__rows">
          {roster.length > 0 ? (
            roster.map((entry) => (
              <RosterRow
                key={entry.provider}
                entry={entry}
                density={density}
                nowMs={nowMs}
                open={flyout === entry.provider}
                flyoutId={flyoutId}
                onOpen={openFlyout}
              />
            ))
          ) : (
            <p className="usage-roster__empty">
              {usageLoading ? "Checking limits…" : "No accounts yet. Add one in Accounts."}
            </p>
          )}
        </div>

        <div className="usage-roster__foot">
          {onOpenUsage ? (
            <button
              type="button"
              className="spark-menu-item"
              data-roster-nav
              onClick={() => {
                onClose(false);
                onOpenUsage();
              }}
            >
              Usage details & history
            </button>
          ) : null}
          <button
            type="button"
            className="spark-menu-item"
            data-roster-nav
            onClick={manageAccounts}
          >
            Manage Accounts…
          </button>
        </div>
      </div>
      {flyoutEntry ? (
        <ProviderFlyout
          forecast={forecast}
          entry={flyoutEntry}
          id={flyoutId}
          nowMs={nowMs}
          flyoutRef={flyoutRef}
          onKeyDown={onFlyoutKeyDown}
          style={
            {
              top: flyoutStyle?.top ?? top,
              left: flyoutStyle?.left ?? left,
              width: FLYOUT_WIDTH,
              maxHeight: `calc(100vh - ${2 * EDGE}px)`,
              visibility: flyoutStyle ? "visible" : "hidden",
              WebkitAppRegion: "no-drag",
            } as AppRegionStyle
          }
          switching={switching}
          onSwitch={switchTo}
          confirming={confirming}
          onConfirm={(open) => {
            setResetMessage(null);
            setConfirming(open);
            if (!open) {
              window.requestAnimationFrame(() => {
                flyoutRef.current?.querySelector<HTMLElement>("[data-reset-open]")?.focus();
              });
            }
          }}
          resetBusy={resetBusy}
          resetMessage={resetMessage}
          onReset={redeemReset}
          onManageAccounts={manageAccounts}
        />
      ) : null}
    </>
  );
}
