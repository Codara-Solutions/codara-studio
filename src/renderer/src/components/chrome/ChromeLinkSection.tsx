import React, { useState } from "react";

import type { ChromeLinkBrowserState, ChromeLinkIncompatibleExtension } from "@shared/chrome-link";
import { SettingRow, SettingsSection, ToggleRow } from "../settings/SettingsPrimitives";
import ChromeConnectCard from "./ChromeConnectCard";
import KeepAgentsInChromeRow from "./KeepAgentsInChromeRow";
import { formatWhen, useChromeLink } from "./useChromeLink";
import "./chrome-link.css";

function sharedCount(browser: ChromeLinkBrowserState): number {
  return browser.tabs.filter((tab) => !tab.blocked).length;
}

/**
 * A connected extension older than the one Codara ships. Codara changes it
 * only when the user presses Update extension here; until then it keeps
 * working as it is.
 */
function ExtensionUpdateNotice({
  browser,
  shipped,
  busy,
  onUpdate,
}: {
  browser: ChromeLinkBrowserState;
  shipped: string;
  busy: boolean;
  onUpdate: () => void;
}): React.ReactElement | null {
  const running = browser.extensionVersion ?? "an older version";
  const versions = `This browser runs extension ${running}, Codara ships ${shipped}.`;
  switch (browser.extensionUpdate) {
    case "available":
      return (
        <div className="chrome-update" data-chrome-extension-update="available">
          <div className="chrome-update__text">
            <span>{versions}</span>
            <span className="chrome-update__desc">
              {browser.extensionReloads
                ? `Update extension copies ${shipped} into Codara's extension folder, which every browser that loaded it uses, and restarts the extension in this browser; until you do, ${running} keeps working.`
                : `Update extension copies ${shipped} into Codara's extension folder, which every browser that loaded it uses; then press the reload button on Codara in chrome://extensions. Until you do, ${running} keeps working.`}
            </span>
          </div>
          <button type="button" className="spark-btn is-primary" disabled={busy} onClick={onUpdate}>
            Update extension
          </button>
        </div>
      );
    case "updating":
      return (
        <div className="chrome-update" role="status" data-chrome-extension-update="updating">
          <span className="chrome-update__text">{`Updating the extension to ${shipped}.`}</span>
        </div>
      );
    case "manual":
      return (
        <div className="chrome-update" role="status" data-chrome-extension-update="manual">
          <span className="chrome-update__text">
            {`Codara's extension folder holds ${shipped}, but this browser still runs ${running}. Open chrome://extensions and press the reload button on Codara.`}
          </span>
        </div>
      );
    case "elsewhere":
      return (
        <div className="chrome-update" data-chrome-extension-update="elsewhere">
          <span className="chrome-update__text">
            {`${versions} This browser did not load it from Codara's folder, so Codara leaves it alone: Chrome updates an extension from the Chrome Web Store by itself.`}
          </span>
        </div>
      );
    default:
      return null;
  }
}

/** An extension that tried to connect and speaks another link protocol than this Codara. */
function IncompatibleNotice({
  extension,
  shipped,
  busy,
  onUpdate,
}: {
  extension: ChromeLinkIncompatibleExtension;
  shipped: string;
  busy: boolean;
  onUpdate: () => void;
}): React.ReactElement {
  const who = `${extension.browser.name}'s Codara extension ${extension.version}`.trim();
  const text =
    extension.update === "codara"
      ? `${who} is newer than this Codara understands, so it cannot connect. Update Codara to use it.`
      : extension.copied
        ? `Codara's extension folder now holds ${shipped}. Open chrome://extensions in ${extension.browser.name} and press the reload button on Codara to connect.`
        : extension.fromCodaraFolder
          ? `${who} is too old for this Codara, so it cannot connect. Update extension copies ${shipped} into Codara's extension folder; then press the reload button on Codara in chrome://extensions.`
          : `${who} is too old for this Codara, so it cannot connect. It was not loaded from Codara's folder: update it where you installed it (Chrome updates an extension from the Chrome Web Store by itself).`;
  const canUpdate = extension.update === "extension" && extension.fromCodaraFolder && !extension.copied;
  return (
    <div className="chrome-update" role="alert" data-chrome-incompatible={extension.extensionId}>
      <span className="chrome-update__text">{text}</span>
      {canUpdate ? (
        <button type="button" className="spark-btn is-primary" disabled={busy} onClick={onUpdate}>
          Update extension
        </button>
      ) : null}
    </div>
  );
}

/**
 * Settings > Browser > Chrome extension: how to install the extension in
 * Chrome, Edge, Brave or another Chromium browser, the browsers paired with
 * Codara and the tabs they share, and what agents did there.
 */
export default function ChromeLinkSection(): React.ReactElement | null {
  const state = useChromeLink();
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  if (!state) return null;

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const update = (which: { linkId: string } | { extensionId: string }) =>
    run(async () => {
      setUpdating(true);
      try {
        await window.spark.chromeLink.updateExtension(which);
      } finally {
        setUpdating(false);
      }
    });
  const shipped = state.shippedExtensionVersion ?? "a newer version";
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
        {state.incompatible.map((extension) => (
          <IncompatibleNotice
            key={extension.extensionId}
            extension={extension}
            shipped={shipped}
            busy={updating}
            onUpdate={() => void update({ extensionId: extension.extensionId })}
          />
        ))}
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
                  <ExtensionUpdateNotice
                    browser={browser}
                    shipped={shipped}
                    busy={updating}
                    onUpdate={() => void update({ linkId: browser.linkId })}
                  />
                  {browser.tabs.length > 0 ? (
                    <ul className="chrome-tabs">
                      {browser.tabs.map((tab) => (
                        <React.Fragment key={tab.id}>
                          <li>
                            <span className="spark-mono">{tab.id}</span>
                            <span className="chrome-tabs__title">{tab.blocked ? "Blocked site" : tab.title || tab.url}</span>
                            <span>{tab.attached ? "in use" : tab.storage ? "cookie tools on" : ""}</span>
                          </li>
                          {tab.paused ? (
                            <li className="chrome-tabs__stopped" role="status">
                              <span className="chrome-tabs__title">Shared tabs were paused after a problem reading saved stops: share each tab again.</span>
                            </li>
                          ) : null}
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
