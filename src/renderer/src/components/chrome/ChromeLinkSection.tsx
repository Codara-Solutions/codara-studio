import React, { useState } from "react";

import type { ChromeLinkBrowserState } from "@shared/chrome-link";
import { SettingRow, SettingsSection, ToggleRow } from "../settings/SettingsPrimitives";
import ChromeConnectCard from "./ChromeConnectCard";
import KeepAgentsInChromeRow from "./KeepAgentsInChromeRow";
import { formatWhen, useChromeLink } from "./useChromeLink";
import "./chrome-link.css";

function sharedCount(browser: ChromeLinkBrowserState): number {
  return browser.tabs.filter((tab) => !tab.blocked).length;
}

/**
 * Settings > Browser > Chrome extension: how to install the extension in
 * Chrome, Edge, Brave or another Chromium browser, the browsers paired with
 * Codara and the tabs they share, and what agents did there.
 */
export default function ChromeLinkSection(): React.ReactElement | null {
  const state = useChromeLink();
  const [error, setError] = useState<string | null>(null);
  if (!state) return null;

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const disconnect = (browser: ChromeLinkBrowserState) => run(() => window.spark.chromeLink.disconnect(browser.linkId));

  return (
    <SettingsSection
      title="Chrome extension"
      description="Let agents use tabs of your own Chrome, Edge, Brave or other Chromium browser, with your sign-ins. They see only the tabs you share from the extension's popup, never blocked sites, and every action is logged."
    >
      <KeepAgentsInChromeRow />

      <ToggleRow
        title="Show the agent on your pages"
        desc="While an agent works in a tab you shared: a pointer in its colour with its name, and a Stop button at the bottom of the page that takes the tab back from that agent. The extension's popup has the same switches."
        checked={state.presence.overlay}
        onChange={(overlay) => void run(() => window.spark.chromeLink.setPresence({ overlay }))}
      />
      <ToggleRow
        title="Glow around the page"
        desc="A thin edge in the agent's colour while it works."
        checked={state.presence.overlay && state.presence.glow}
        disabled={!state.presence.overlay}
        onChange={(glow) => void run(() => window.spark.chromeLink.setPresence({ glow }))}
      />

      <SettingRow
        title="Link status"
        desc={
          !state.enabled
            ? "The browser link is turned off for this Codara."
            : state.port
              ? `Listening on 127.0.0.1:${state.port}, for this computer's browsers only.`
              : state.error ?? "Starting."
        }
      />

      <SettingRow
        title="Connect a browser"
        stacked
        desc="Add the extension, pair it, share a tab. Each step moves on by itself when Codara sees it done."
      >
        <ChromeConnectCard state={state} />
      </SettingRow>

      <SettingRow
        title="Paired browsers"
        stacked
        desc={state.browsers.length === 0 ? "None yet. Follow the steps above to connect one." : "Disconnect forgets a browser. Its extension must connect again, with a new code."}
      >
        {error ? <div className="chrome-folder__path" role="alert">{error}</div> : null}
        {state.browsers.length > 0 ? (
          <div className="st-list">
            {state.browsers.map((browser) => (
              <div key={browser.linkId} className="st-list__row st-device" data-chrome-link={browser.linkId}>
                <div className="st-device__text">
                  <div className="st-device__name">
                    {`${browser.browser.name} ${browser.browser.version}`.trim()}
                    {browser.connected ? "" : " (not connected)"}
                  </div>
                  <div className="st-device__meta">
                    {`${sharedCount(browser)} shared tab${sharedCount(browser) === 1 ? "" : "s"}, paired ${formatWhen(browser.pairedAt)}, last seen ${browser.connected ? "now" : formatWhen(browser.lastSeenAt)}`}
                  </div>
                  {browser.extensionUpdate ? (
                    <div className="st-device__meta" role="status" data-chrome-extension-update={browser.extensionUpdate}>
                      {browser.extensionUpdate === "updating"
                        ? `Updating the extension to ${state.shippedExtensionVersion ?? "the latest version"}.`
                        : `This browser runs extension ${browser.extensionVersion ?? "an older version"}, Codara ships ${state.shippedExtensionVersion ?? "a newer one"}. Update the extension: open chrome://extensions and press the reload button on Codara.`}
                    </div>
                  ) : null}
                  {browser.tabs.length > 0 ? (
                    <ul className="chrome-tabs">
                      {browser.tabs.map((tab) => (
                        <React.Fragment key={tab.id}>
                          <li>
                            <span className="spark-mono">{tab.id}</span>
                            <span className="chrome-tabs__title">{tab.blocked ? "Blocked site" : tab.title || tab.url}</span>
                            <span>{tab.attached ? "in use" : tab.storage ? "cookie tools on" : ""}</span>
                          </li>
                          {tab.stopped.map((agent) => (
                            <li key={`${tab.id}-${agent.key}`} className="chrome-tabs__stopped">
                              <span className="chrome-tabs__title">{`You stopped ${agent.name} here.`}</span>
                              <button
                                type="button"
                                className="spark-btn"
                                onClick={() => void run(() => window.spark.chromeLink.giveBack(browser.linkId, Number(tab.id.split(/[:/]/).pop()), agent.key))}
                              >
                                Give back
                              </button>
                            </li>
                          ))}
                        </React.Fragment>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <button type="button" className="spark-btn is-danger" onClick={() => void disconnect(browser)}>
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </SettingRow>

      <SettingRow
        title="Agent activity in your browser"
        stacked
        desc={state.activity.length === 0 ? "Nothing yet." : "The latest browser tool calls on your browser's tabs, newest first."}
      >
        {state.activity.length > 0 ? (
          <ul className="chrome-activity">
            {state.activity.slice(0, 12).map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <span>{formatWhen(entry.at)}</span>
                <span className="chrome-activity__what">
                  {`${entry.agent}: ${entry.tool.replace(/^codara_preview_/, "")}${entry.tab ? ` on ${entry.tab}` : ""}${entry.detail ? `, ${entry.detail}` : ""}`}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingRow>
    </SettingsSection>
  );
}
