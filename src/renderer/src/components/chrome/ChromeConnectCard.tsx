import React, { useEffect, useState } from "react";

import { chromeConnectProgress, type ChromeConnectStep, type ChromeLinkState } from "@shared/chrome-link";
import { useConnectCardOnScreen } from "./useChromeLink";
import "./chrome-link.css";

/**
 * How the extension gets into the browser. Today the user loads Codara's
 * folder unpacked. Once the Chrome Web Store listing is live, a "store" route
 * with its URL turns the Add step into one "Add from Chrome Web Store"
 * button; the other steps and every check stay as they are.
 */
export type ChromeInstallRoute = { kind: "unpacked" } | { kind: "store"; url: string };
export const CHROME_INSTALL_ROUTE: ChromeInstallRoute = { kind: "unpacked" };

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
}: {
  state: ChromeLinkState;
  route?: ChromeInstallRoute;
}): React.ReactElement {
  useConnectCardOnScreen();
  const progress = chromeConnectProgress(state);
  const [another, setAnother] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new browser paired: the extra round is over.
  useEffect(() => setAnother(false), [progress.paired]);
  const step: ChromeConnectStep = another && progress.step === "done" ? "add" : progress.step;
  const current = STEPS.findIndex((item) => item.id === step);

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
  const pairing = state.pending[0];

  return (
    <div className="chrome-connect" data-chrome-connect={step}>
      <div className="chrome-connect__top">
        <span className="chrome-connect__title">Connect your browser</span>
        <span className="chrome-connect__browsers">Chrome, Edge, Brave and other Chromium browsers. Firefox: coming later.</span>
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

      <div className="chrome-connect__focus">
        {step === "add" ? (
          route.kind === "store" ? (
            <>
              <div className="chrome-connect__h">Add Codara to your browser</div>
              <p className="chrome-connect__d">
                The store page opens in your browser. Press <strong>Add to Chrome</strong>, then the Codara icon in the toolbar and{" "}
                <strong>Connect to Codara</strong>.
              </p>
              <div className="chrome-connect__actions">
                <button type="button" className="spark-btn is-primary" onClick={() => void run(() => window.spark.openInSystemBrowser(route.url))}>
                  Add from Chrome Web Store
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
                  In your browser open{" "}
                  <button type="button" className="chrome-connect__copy spark-mono" title="Copy" onClick={() => void copy("address", async () => "chrome://extensions")}>
                    {copied === "address" ? "Copied" : "chrome://extensions"}
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
              <span className="chrome-connect__code spark-mono" aria-label="Pairing code">
                {pairing.code}
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
        ) : step === "share" ? (
          <>
            <div className="chrome-connect__h">Share a tab with agents</div>
            <p className="chrome-connect__d">
              Open a site agents may use, click the Codara icon and turn on <strong>Let agents use this tab</strong>. Agents never see
              the tabs you do not share.
            </p>
          </>
        ) : (
          <>
            <div className="chrome-connect__h">Your browser is connected</div>
            <p className="chrome-connect__d">
              {`${progress.paired} browser${progress.paired === 1 ? "" : "s"} paired, ${progress.shared} tab${progress.shared === 1 ? "" : "s"} shared. Share or stop tabs from the extension's popup.`}
            </p>
            <div className="chrome-connect__actions">
              <button type="button" className="spark-btn" onClick={() => setAnother(true)}>
                Connect another browser
              </button>
            </div>
          </>
        )}
      </div>

      {step === "add" || step === "share" ? (
        <div className="chrome-connect__wait" role="status">
          <span className="chrome-connect__pulse" aria-hidden="true" />
          {step === "add"
            ? "Waiting for the extension. This moves on by itself when you press Connect to Codara."
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
