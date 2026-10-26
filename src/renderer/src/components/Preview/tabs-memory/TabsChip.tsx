import { useEffect, useMemo, useRef, useState } from "react";

import { tabLink } from "@shared/tab-links";
import AnchoredMenu from "../../chat/composer/AnchoredMenu";
import { Switch } from "../../capabilities/controls";
import { CloseIcon, ReloadIcon } from "../../icons";
import { MoonIcon } from "../../Terminal/AgentSleepControls";
import { presenceState } from "../agent-presence/store";
import { closePreviewTab } from "../registry";
import { openTabLink } from "../../../tabs/tabLinkBridge";
import { TabsIcon } from "../toolbar/icons";
import {
  appMemory,
  browserWorkspaceName,
  setAutoSleepEnabled,
  sleepTab,
  sleepTabsOutside,
  tabSleepBlocker,
  useAutoSleep,
  useBrowserTabs,
  wakeTab,
  watchTabMemory,
  type BrowserTabRecord,
} from "./browserTabs";
import { AGENT_ACTIVE_MS, formatAsleepFor, formatMemory, shortUrl, sleepBlockerText } from "./sleepPolicy";
import { BROWSER_MENU_Z } from "../fullScreen";

// The toolbar's "7 · 348 MB" chip and the view it opens: every browser tab in
// every workspace with the memory its page uses, a way to put it to sleep or
// close it, and the auto-sleep switch. A sleeping tab keeps its title, URL
// and last picture and loads again when it is shown.

interface Props {
  tabId: string | null;
  workspaceId: string | null;
}

function tabTitle(tab: BrowserTabRecord): string {
  return tab.title.trim() || shortUrl(tab.url) || "New tab";
}

function tabLetter(tab: BrowserTabRecord): string {
  const title = tab.title.trim();
  if (title) return title[0];
  try {
    const host = new URL(tab.url).hostname.replace(/^www\./, "");
    if (host) return host[0];
  } catch {
    /* no letter to take */
  }
  return "?";
}

function agentName(tabId: string, now: number): string | null {
  const presence = presenceState(tabId);
  if (!presence.driver || now - presence.activeAt > AGENT_ACTIVE_MS) return null;
  return presence.driver.name;
}

export function totalMemory(tabs: readonly BrowserTabRecord[]): number {
  return tabs.reduce((sum, tab) => sum + (tab.asleep ? 0 : tab.memoryBytes ?? 0), 0);
}

export default function TabsChip({ tabId, workspaceId }: Props) {
  const tabs = useBrowserTabs();
  const autoSleep = useAutoSleep();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => watchTabMemory(open), [open]);

  const total = totalMemory(tabs);
  const asleep = tabs.filter((tab) => tab.asleep).length;
  const groups = useMemo(() => {
    const byWorkspace = new Map<string | null, BrowserTabRecord[]>();
    for (const tab of tabs) {
      const list = byWorkspace.get(tab.workspaceId) ?? [];
      list.push(tab);
      byWorkspace.set(tab.workspaceId, list);
    }
    return [...byWorkspace.entries()].sort(([a], [b]) => (a === workspaceId ? -1 : b === workspaceId ? 1 : 0));
  }, [tabs, workspaceId]);
  const othersAwake = tabs.some((tab) => tab.workspaceId !== workspaceId && !tab.asleep);
  const now = Date.now();
  // Nothing until the first reading, rather than "0 MB".
  const measured = tabs.some((tab) => tab.memoryBytes !== null);
  const memoryText = measured ? formatMemory(total) : "";
  const summary = `${tabs.length} browser tab${tabs.length === 1 ? "" : "s"}${asleep ? `, ${asleep} asleep` : ""}${memoryText ? `, ${memoryText}` : ""}`;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="bp-chip"
        data-testid="preview-tabs-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Browser tabs and memory: ${summary}`}
        title={`${summary}. Open the list to put tabs to sleep and free memory.`}
        onClick={() => setOpen((value) => !value)}
      >
        <TabsIcon size={13} />
        <span>{tabs.length}</span>
        {memoryText ? (
          <>
            <span className="bp-chip__dot">·</span>
            <span className="bp-chip__memory">{memoryText}</span>
          </>
        ) : null}
      </button>
      <AnchoredMenu
        zIndex={BROWSER_MENU_Z}
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        className="spark-menu bp-menu"
        role="dialog"
        ariaLabel="Browser tabs and memory"
        placement="below"
        align="end"
      >
        <div className="bp-tabs" data-testid="preview-tabs-view">
          <div className="bp-tabs__list">
            {groups.length === 0 ? <div className="bp-tabs__empty">No browser tabs are open.</div> : null}
            {groups.map(([group, list]) => (
              <section key={group ?? "none"} aria-label={browserWorkspaceName(group)}>
                <div className="bp-tabs__group">
                  <span className="bp-tabs__group-name">
                    {browserWorkspaceName(group)}
                    {group === workspaceId ? " · this workspace" : ""}
                  </span>
                  <span>{formatMemory(totalMemory(list))}</span>
                </div>
                {list.map((tab) => (
                  <TabRow
                    key={tab.id}
                    tab={tab}
                    current={tab.id === tabId}
                    agent={agentName(tab.id, now)}
                    now={now}
                    onOpen={() => {
                      setOpen(false);
                      if (tab.workspaceId) openTabLink(tabLink(tab.workspaceId, tab.id));
                    }}
                  />
                ))}
              </section>
            ))}
          </div>
          {othersAwake || appMemory() ? (
            <div className="bp-tabs__extra">
              <span>{appMemory() ? `Codara uses ${formatMemory(appMemory())} in all` : ""}</span>
              {othersAwake ? (
                <button type="button" className="spark-btn" data-testid="preview-sleep-others" onClick={() => sleepTabsOutside(workspaceId)}>
                  <MoonIcon size={11} /> Sleep other workspaces
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="bp-tabs__foot">
            <Switch
              checked={autoSleep}
              onChange={setAutoSleepEnabled}
              ariaLabel="Sleep tabs I have not looked at for 30 minutes"
            />
            <span className="bp-tabs__foot-label">
              Sleep tabs I have not looked at for <strong>30 min</strong>
            </span>
            <span className="bp-tabs__total">{memoryText}</span>
          </div>
        </div>
      </AnchoredMenu>
    </>
  );
}

function TabRow({
  tab,
  current,
  agent,
  now,
  onOpen,
}: {
  tab: BrowserTabRecord;
  current: boolean;
  agent: string | null;
  now: number;
  onOpen: () => void;
}) {
  const blocker = tab.asleep ? null : tabSleepBlocker(tab.id);
  const title = tabTitle(tab);
  return (
    <div
      className={`bp-tab${current ? " is-current" : ""}${tab.asleep ? " is-asleep" : ""}`}
      data-testid="preview-tab-row"
      data-tab-id={tab.id}
      data-asleep={tab.asleep ? "true" : undefined}
    >
      <button type="button" className="bp-tab__open" onClick={onOpen} title={`Show ${title}`}>
        <span className="bp-tab__letter" aria-hidden>{tabLetter(tab)}</span>
        <span className="bp-tab__text">
          <span className="bp-tab__title">{title}</span>
          <span className="bp-tab__url">{shortUrl(tab.url)}</span>
        </span>
      </button>
      {agent && !tab.asleep ? <span className="bp-tab__badge is-agent">{agent} is using</span> : null}
      {tab.asleep ? (
        <span className="bp-tab__badge is-asleep">
          <MoonIcon size={10} /> {formatAsleepFor(now - (tab.asleepAt ?? now))}
        </span>
      ) : null}
      <span className="bp-tab__mem">{tab.asleep ? "0 MB" : formatMemory(tab.memoryBytes)}</span>
      <span className="bp-tab__actions">
        {tab.asleep ? (
          <button
            type="button"
            className="spark-icon-btn"
            aria-label={`Wake ${title}`}
            title="Wake: load the page again"
            onClick={() => wakeTab(tab.id)}
            style={{ ["--spark-icon-btn-size" as string]: "24px" }}
          >
            <ReloadIcon size={12} />
          </button>
        ) : (
          <button
            type="button"
            className="spark-icon-btn"
            aria-label={`Sleep ${title}`}
            title={blocker ? sleepBlockerText(blocker) : "Sleep: free its memory, keep its title and URL"}
            aria-disabled={blocker !== null}
            onClick={() => {
              if (!blocker) sleepTab(tab.id);
            }}
            style={{ ["--spark-icon-btn-size" as string]: "24px" }}
          >
            <MoonIcon size={12} />
          </button>
        )}
        <button
          type="button"
          className="spark-icon-btn"
          aria-label={`Close ${title}`}
          title="Close this tab"
          onClick={() => closePreviewTab(tab.id)}
          style={{ ["--spark-icon-btn-size" as string]: "24px" }}
        >
          <CloseIcon size={11} />
        </button>
      </span>
    </div>
  );
}
