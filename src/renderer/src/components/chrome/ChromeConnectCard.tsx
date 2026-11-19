import React, { useEffect, useRef, useState } from "react";

import { chromeConnectProgress, type ChromeConnectStep, type ChromeLinkState } from "@shared/chrome-link";
import { Segmented } from "../settings/SettingsPrimitives";
import { FIREFOX_DEBUGGING_ADDRESS, FirefoxLoadActions, FirefoxWhyNote, useCanOpenFirefoxDebugging } from "./FirefoxReload";
import { useConnectCardOnScreen } from "./useChromeLink";
import "./chrome-link.css";
import "./chrome-connect.css";

/**
 * How the extension gets into the browser. Today the user loads Codara's
 * folder unpacked. Once the Chrome Web Store listing is live, a "store" route
 * with its URL turns the Add step into one "Add from Chrome Web Store"
 * button; the other steps and every check stay as they are.
 */
export type ChromeInstallRoute = { kind: "unpacked" } | { kind: "store"; url: string };
export const CHROME_INSTALL_ROUTE: ChromeInstallRoute = { kind: "unpacked" };

/**
 * How the add-on gets into Firefox. Today the user loads Codara's folder as a
 * temporary add-on. A "store" route with a listing's URL would turn the Add
 * step into one "Add from Firefox Add-ons" button; there is no listing, and
 * none can be submitted as the add-on stands (extensions/firefox/LISTING.txt).
 */
export type FirefoxInstallRoute = { kind: "temporary" } | { kind: "store"; url: string };
export const FIREFOX_INSTALL_ROUTE: FirefoxInstallRoute = { kind: "temporary" };

type BrowserFamily = "chromium" | "firefox";
const BROWSER_FAMILIES: { value: BrowserFamily; label: string }[] = [
  { value: "chromium", label: "Chrome, Edge, Brave" },
  { value: "firefox", label: "Firefox" },
];

const STEPS: { id: Exclude<ChromeConnectStep, "done">; label: string }[] = [
  { id: "add", label: "Add" },
  { id: "pair", label: "Pair" },
  { id: "share", label: "Share a tab" },
];

/**
 * Connect a browser, one step at a time: add the extension, pair it, share a
 * tab. Each step moves on by itself when Codara sees it done. In Settings >
 * Browser and in the first-run guide.
 */
export default function ChromeConnectCard({
  state,
  route = CHROME_INSTALL_ROUTE,
  firefoxRoute = FIREFOX_INSTALL_ROUTE,
}: {
  state: ChromeLinkState;
  route?: ChromeInstallRoute;
  firefoxRoute?: FirefoxInstallRoute;
}): React.ReactElement {
  useConnectCardOnScreen();
  const progress = chromeConnectProgress(state);
  const [another, setAnother] = useState(false);
  // With the store route, the folder steps stay one click away.
  const [unpacked, setUnpacked] = useState(false);
  const [firefoxTemporary, setFirefoxTemporary] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [family, setFamily] = useState<BrowserFamily>("chromium");
  const [firefoxFolder, setFirefoxFolder] = useState<string | null>(null);
  const [firefoxManifest, setFirefoxManifest] = useState<string | null>(null);
  const canOpenFirefoxPage = useCanOpenFirefoxDebugging();
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pairRef = useRef<HTMLDivElement>(null);
  // A new browser paired: the extra round is over.
  useEffect(() => setAnother(false), [progress.paired]);
  // Another browser's round stays at Add until it asks to pair, whatever the
  // first browser's tabs do meanwhile.
  const step: ChromeConnectStep = another && progress.step !== "pair" ? "add" : progress.step;
  const pairingId = state.pending[0]?.id;
  // The floating prompt stays away while a card is on screen, so the card's
  // own Allow must be in view (never focused: approving takes a deliberate click).
  useEffect(() => {
    if (pairingId) pairRef.current?.scrollIntoView({ block: "nearest" });
  }, [pairingId]);
  // Paired but offline: the browser has to come back and pair again or reconnect, so Pair is current.
  const current = STEPS.findIndex((item) => item.id === (step === "offline" ? "pair" : step));

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const copy = (what: string, text: () => Promise<string>) =>
    run(async () => {
      await navigator.clipboard.writeText(await text());
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  const shownFolder = folder ?? state.extensionFolder;
  const shownFirefoxFolder = firefoxFolder ?? state.firefoxExtensionFolder;
  // The file Load Temporary Add-on asks for, in the folder's own separator.
  const shownFirefoxManifest =
    firefoxManifest ?? (shownFirefoxFolder ? `${shownFirefoxFolder}${/\\/.test(shownFirefoxFolder) && !shownFirefoxFolder.includes("/") ? "\\" : "/"}manifest.json` : null);
  // Firefox asks for the site and for scripts in pages from its popup, after sharing.
  const firefoxConnected = state.browsers.some((browser) => browser.connected && /firefox/i.test(browser.browser.name));
  // A temporary add-on is gone after every Firefox restart: say so, and how to load it again.
  const firefoxOffline = progress.offline.some((name) => /firefox/i.test(name));
  const pairing = state.pending[0];

  // Nothing can connect while the link is off: say why instead of the steps.
  if (!state.enabled || !state.port) {
    return (
      <div className="chrome-connect" data-chrome-connect="off">
        <div className="chrome-connect__top">
          <span className="chrome-connect__title">Connect your browser</span>
        </div>
        <div className="chrome-connect__error" role="alert">
          {!state.enabled
            ? "The browser link is turned off for this Codara, so no browser can connect."
            : state.error ?? "The browser link is starting."}
        </div>
      </div>
    );
  }

  return (
    <div className="chrome-connect" data-chrome-connect={step}>
      <div className="chrome-connect__top">
        <span className="chrome-connect__title">Connect your browser</span>
        <span className="chrome-connect__browsers">Chrome, Edge, Brave and other Chromium browsers, or Firefox 153 and later.</span>
      </div>

      <ol className="chrome-connect__steps" aria-label="Steps">
        {STEPS.map((item, index) => {
          const done = step === "done" || index < current;
          const here = index === current;
          return (
            <li key={item.id} data-state={done ? "done" : here ? "current" : "next"} aria-current={here ? "step" : undefined}>
              <span className="chrome-connect__n" aria-hidden="true">
                {done ? "✓" : index + 1}
              </span>
              <span>{item.label}</span>
              {done ? <span className="spark-sr-only"> (done)</span> : null}
            </li>
          );
        })}
      </ol>

      <div className="chrome-connect__focus" ref={pairRef}>
        {step === "add" ? (
          <Segmented ariaLabel="Your browser" options={BROWSER_FAMILIES} value={family} onChange={setFamily} />
        ) : null}
        {step === "add" && family === "firefox" ? (
          firefoxRoute.kind === "store" && !firefoxTemporary ? (
            <>
              <div className="chrome-connect__h">Add Codara to Firefox</div>
              <p className="chrome-connect__d">
                The add-on page opens in your default browser. If that is not Firefox, open the same page in Firefox. Press{" "}
                <strong>Add to Firefox</strong>, then the Codara icon in the toolbar and <strong>Connect to Codara</strong>.
              </p>
              <div className="chrome-connect__actions">
                <button type="button" className="spark-btn is-primary" onClick={() => void run(() => window.spark.openInSystemBrowser(firefoxRoute.url))}>
                  Add from Firefox Add-ons
                </button>
                <button type="button" className="chrome-connect__link" onClick={() => setFirefoxTemporary(true)}>
                  Load it temporarily instead
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="chrome-connect__h">Add the extension to Firefox</div>
              <ol className="chrome-steps">
                <li>
                  In Firefox open <span className="spark-mono">{FIREFOX_DEBUGGING_ADDRESS}</span>{" "}
                  {canOpenFirefoxPage ? (
                    <button
                      type="button"
                      className="spark-btn is-primary chrome-connect__inline-btn"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        if (!(await window.spark.chromeLink.openFirefoxDebugging())) throw new Error(`Codara could not start Firefox: open ${FIREFOX_DEBUGGING_ADDRESS} in it yourself.`);
                      })}
                    >
                      Open in Firefox
                    </button>
                  ) : (
                    <button type="button" className="chrome-connect__copy" onClick={() => void copy("firefox-address", async () => FIREFOX_DEBUGGING_ADDRESS)}>
                      {copied === "firefox-address" ? "Copied" : "Copy"}
                    </button>
                  )}
                </li>
                <li>
                  Choose <strong>Load Temporary Add-on</strong> and pick this <span className="spark-mono">manifest.json</span>.
                  <div className="chrome-connect__tip">
                    Tip: paste the path into the file dialog (Ctrl+L on Linux, Cmd+Shift+G on macOS, the File name box on Windows).
                  </div>
                  <div className="chrome-folder">
                    <span className="chrome-folder__path spark-mono" title={shownFirefoxManifest ?? undefined}>
                      {shownFirefoxManifest ?? "This Codara build does not include the extension for Firefox."}
                    </span>
                    <button
                      type="button"
                      className="spark-btn"
                      disabled={busy || !shownFirefoxFolder}
                      onClick={() => void copy("firefox-path", async () => {
                        const path = await window.spark.chromeLink.prepareFirefoxManifest();
                        setFirefoxManifest(path);
                        return path;
                      })}
                    >
                      {copied === "firefox-path" ? "Copied" : "Copy path"}
                    </button>
                    <button
                      type="button"
                      className="spark-btn"
                      disabled={busy || !shownFirefoxFolder}
                      onClick={() => void run(async () => setFirefoxFolder(await window.spark.chromeLink.revealFirefoxExtension()))}
                    >
                      Reveal folder
                    </button>
                  </div>
                </li>
                <li>
                  Click the Codara icon in the toolbar (pin it from the puzzle piece) and press <strong>Connect to Codara</strong>.
                </li>
              </ol>
              <p className="chrome-connect__d">
                Firefox removes a temporary add-on when it quits: load it again after a restart (it keeps its pairing and settings).
              </p>
              <FirefoxWhyNote />
            </>
          )
        ) : step === "add" ? (
          route.kind === "store" && !unpacked ? (
            <>
              <div className="chrome-connect__h">Add Codara to your browser</div>
              <p className="chrome-connect__d">
                The store page opens in your default browser. If that is not the browser you want to connect, open the same page there.
                Press <strong>Add to Chrome</strong>, then the Codara icon in the toolbar and <strong>Connect to Codara</strong>.
              </p>
              <div className="chrome-connect__actions">
                <button type="button" className="spark-btn is-primary" onClick={() => void run(() => window.spark.openInSystemBrowser(route.url))}>
                  Add from Chrome Web Store
                </button>
                <button type="button" className="chrome-connect__link" onClick={() => setUnpacked(true)}>
                  Load unpacked instead
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="chrome-connect__h">Add the extension to your browser</div>
              <ol className="chrome-steps">
                <li>
                  <strong>Reveal the extension folder</strong> (or copy its path).
                  <div className="chrome-folder">
                    <span className="chrome-folder__path spark-mono" title={shownFolder}>
                      {shownFolder}
                    </span>
                    <button
                      type="button"
                      className="spark-btn"
                      disabled={busy}
                      onClick={() => void copy("path", async () => {
                        const path = await window.spark.chromeLink.prepareExtension();
                        setFolder(path);
                        return path;
                      })}
                    >
                      {copied === "path" ? "Copied" : "Copy path"}
                    </button>
                    <button
                      type="button"
                      className="spark-btn is-primary"
                      disabled={busy}
                      onClick={() => void run(async () => setFolder(await window.spark.chromeLink.revealExtension()))}
                    >
                      Reveal folder
                    </button>
                  </div>
                </li>
                <li>
                  In your browser open <span className="spark-mono">chrome://extensions</span>{" "}
                  <button type="button" className="chrome-connect__copy" onClick={() => void copy("address", async () => "chrome://extensions")}>
                    {copied === "address" ? "Copied" : "Copy"}
                  </button>{" "}
                  (Edge: <span className="spark-mono">edge://extensions</span>), turn on <strong>Developer mode</strong>, choose{" "}
                  <strong>Load unpacked</strong> and pick that folder.
                </li>
                <li>
                  Click the Codara icon in the toolbar (pin it from the puzzle piece) and press <strong>Connect to Codara</strong>.
                </li>
              </ol>
            </>
          )
        ) : step === "pair" && pairing ? (
          <>
            <div className="chrome-connect__h">{pairing.browser.name} is asking to connect</div>
            <p className="chrome-connect__d">The Codara popup in your browser shows a code. Allow only if it is the same.</p>
            <div className="chrome-connect__pair">
              <span className="chrome-connect__code-wrap">
                <span className="chrome-connect__code-label">Code</span>{" "}
                <span className="chrome-connect__code spark-mono">{pairing.code}</span>
              </span>
              <span className="chrome-connect__actions">
                <button type="button" className="spark-btn" disabled={busy} onClick={() => void run(() => window.spark.chromeLink.deny(pairing.id))}>
                  Deny
                </button>
                <button type="button" className="spark-btn is-primary" disabled={busy} onClick={() => void run(() => window.spark.chromeLink.approve(pairing.id))}>
                  Allow
                </button>
              </span>
            </div>
          </>
        ) : step === "offline" ? (
          <>
            <div className="chrome-connect__h">{`${progress.offline.join(", ")} ${progress.offline.length === 1 ? "is" : "are"} paired but not connected`}</div>
            {firefoxOffline ? (
              <>
                <p className="chrome-connect__d" data-firefox-offline="">
                  Firefox removes the Codara add-on each time it restarts, so it has to be loaded again: in Firefox open{" "}
                  <span className="spark-mono">{FIREFOX_DEBUGGING_ADDRESS}</span>, choose <strong>Load Temporary Add-on</strong> and pick{" "}
                  <strong>manifest.json</strong> in the extension folder. It keeps its pairing and settings, and connects again by itself.
                </p>
                <div className="chrome-connect__actions">
                  <FirefoxLoadActions onError={setError} />
                </div>
              </>
            ) : null}
            <p className="chrome-connect__d">
              Open it, or add the extension again. It connects by itself while Codara is running; if it does not, click the Codara icon in
              the toolbar and press <strong>Connect to Codara</strong>.
            </p>
            <div className="chrome-connect__actions">
              {firefoxOffline ? (
                <button
                  type="button"
                  className="spark-btn"
                  onClick={() => {
                    setFamily("firefox");
                    setAnother(true);
                  }}
                >
                  Show the Firefox steps
                </button>
              ) : null}
              <button type="button" className="spark-btn" onClick={() => setAnother(true)}>
                Add the extension again
              </button>
            </div>
          </>
        ) : step === "share" ? (
          <>
            <div className="chrome-connect__h">Share a tab with agents</div>
            <p className="chrome-connect__d">
              Open a site agents may use, click the Codara icon and turn on <strong>Let agents use this tab</strong>. Agents never see
              the tabs you do not share.
            </p>
            {firefoxConnected ? <FirefoxAccessNote /> : null}
            <div className="chrome-connect__actions">
              <button type="button" className="spark-btn" onClick={() => setAnother(true)}>
                Connect another browser
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="chrome-connect__h">Your browser is connected</div>
            <p className="chrome-connect__d">
              {`${progress.paired} browser${progress.paired === 1 ? "" : "s"} paired, ${progress.shared} tab${progress.shared === 1 ? "" : "s"} shared. Share or stop tabs from the extension's popup.`}
            </p>
            {firefoxConnected ? <FirefoxAccessNote /> : null}
            <div className="chrome-connect__actions">
              <button type="button" className="spark-btn" onClick={() => setAnother(true)}>
                Connect another browser
              </button>
            </div>
          </>
        )}
      </div>

      {step === "add" || step === "share" || step === "offline" ? (
        <div className="chrome-connect__wait" role="status">
          <span className="chrome-connect__pulse" aria-hidden="true" />
          {step === "add"
            ? "Waiting for the extension. This moves on by itself when you press Connect to Codara."
            : step === "offline"
              ? "Waiting for the browser. This moves on by itself when it connects."
              : "Waiting for a shared tab. This moves on by itself."}
        </div>
      ) : null}
      {another && step === "add" ? (
        <button type="button" className="chrome-connect__link" onClick={() => setAnother(false)}>
          Cancel
        </button>
      ) : null}
      {error ? (
        <div className="chrome-connect__error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** Firefox shares a tab before it lets the extension into the page: its popup asks for both, after sharing. */
function FirefoxAccessNote(): React.ReactElement {
  return (
    <p className="chrome-connect__d">
      In Firefox, agents can read and act on a shared tab only once its popup has your OK: press <strong>Allow</strong> with the site's name and{" "}
      <strong>Allow scripts</strong> there.
    </p>
  );
}
