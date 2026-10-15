import React, { useState } from "react";

import type { ChromeLinkBrowserState } from "@shared/chrome-link";
import { Disclosure, SettingRow, SettingsSection } from "../settings/SettingsPrimitives";
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
  const [folder, setFolder] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  if (!state) return null;
  // The steps stay open until a browser is paired; after that they fold.
  const showSteps = stepsOpen || state.browsers.length === 0;

  const shownFolder = folder ?? state.extensionFolder;
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const copyFolder = () =>
    run(async () => {
      const path = await window.spark.chromeLink.prepareExtension();
      setFolder(path);
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  const reveal = () => run(async () => setFolder(await window.spark.chromeLink.revealExtension()));
  const disconnect = (browser: ChromeLinkBrowserState) => run(() => window.spark.chromeLink.disconnect(browser.linkId));

  return (
    <SettingsSection
      title="Chrome extension"
      description="Let agents use tabs of your own Chrome, Edge, Brave or other Chromium browser, with your sign-ins. They see only the tabs you share from the extension's popup, never blocked sites, and every action is logged."
    >
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

      {state.pending.map((pairing) => (
        <SettingRow
          key={pairing.id}
          anchor="Link status"
          title={`${pairing.browser.name} wants to connect`}
          desc={`Allow it only if the extension shows the code ${pairing.code}.`}
          control={
            <span className="st-button-pair">
              <button type="button" className="spark-btn" onClick={() => void run(() => window.spark.chromeLink.deny(pairing.id))}>
                Deny
              </button>
              <button type="button" className="spark-btn is-primary" onClick={() => void run(() => window.spark.chromeLink.approve(pairing.id))}>
                Allow
              </button>
            </span>
          }
        />
      ))}

      <SettingRow
        title="Connect a browser"
        stacked
        desc="Load the extension folder in your browser, then pair it with Codara."
      >
        <div className="chrome-folder">
          <span className="chrome-folder__path spark-mono" title={shownFolder}>
            {shownFolder}
          </span>
          <button type="button" className="spark-btn" onClick={() => void copyFolder()}>
            {copied ? "Copied" : "Copy path"}
          </button>
          <button type="button" className="spark-btn is-primary" onClick={() => void reveal()}>
            Reveal folder
          </button>
        </div>
        {error ? <div className="chrome-folder__path" role="alert">{error}</div> : null}
        {state.browsers.length > 0 ? (
          <Disclosure open={stepsOpen} onToggle={() => setStepsOpen((open) => !open)}>
            How to connect
          </Disclosure>
        ) : null}
        {showSteps ? (
          <ol className="chrome-steps">
            <li>
              <strong>Reveal the extension folder</strong> (or copy its path).
            </li>
            <li>
              In your browser open <span className="spark-mono">chrome://extensions</span> (Edge:{" "}
              <span className="spark-mono">edge://extensions</span>), turn on <strong>Developer mode</strong>, choose{" "}
              <strong>Load unpacked</strong> and pick that folder.
            </li>
            <li>
              Click the Codara icon in the toolbar and choose <strong>Connect to Codara</strong>.
            </li>
            <li>
              Codara shows a code: <strong>Allow</strong> it when it matches the popup&apos;s. Then turn on{" "}
              <strong>Let agents use this tab</strong> in the popup for each tab agents may use.
            </li>
          </ol>
        ) : null}
      </SettingRow>

      <SettingRow
        title="Paired browsers"
        stacked
        desc={state.browsers.length === 0 ? "None yet. Follow the steps above to connect one." : "Disconnect forgets a browser. Its extension must connect again, with a new code."}
      >
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
                  {browser.tabs.length > 0 ? (
                    <ul className="chrome-tabs">
                      {browser.tabs.map((tab) => (
                        <li key={tab.id}>
                          <span className="spark-mono">{tab.id}</span>
                          <span className="chrome-tabs__title">{tab.blocked ? "Blocked site" : tab.title || tab.url}</span>
                          <span>{tab.attached ? "in use" : tab.storage ? "cookies allowed" : ""}</span>
                        </li>
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
