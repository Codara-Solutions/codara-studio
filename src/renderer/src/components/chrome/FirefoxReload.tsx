import React, { useEffect, useRef, useState } from "react";

import type { ChromeLinkState } from "@shared/chrome-link";
import { GoneFirefoxTracker } from "./firefox-gone";
import { useChromeLink, useConnectCardShown } from "./useChromeLink";
import "./chrome-link.css";

// Loading the Codara add-on into Firefox, made as short as it honestly can
// be: Firefox loads it as a developer (temporary) add-on, from its
// about:debugging page, and drops it at every restart. Codara opens that page
// in the user's Firefox where it can (Linux), copies the manifest.json path
// the file dialog asks for, and after a paired Firefox drops, says so once.

export const FIREFOX_DEBUGGING_ADDRESS = "about:debugging#/runtime/this-firefox";
/** What Open in Firefox starts, said on the button. */
export const OPEN_IN_FIREFOX_TITLE = "Opens this page in Mozilla Firefox. Forks such as LibreWolf are not opened: copy the address instead.";
/** The README's install section: why a developer add-on, and how Developer Edition, Nightly or ESR keep it. */
export const FIREFOX_INSTALL_DOCS = "https://github.com/Codara-Solutions/codara-studio/blob/main/extensions/firefox/README.md";
/**
 * A paired Firefox that stays away this long has really gone (closed or
 * restarted), not blinked: longer than the add-on's own 30 s wake alarm and
 * first 30 s reconnect step (extensions/firefox/background.js, link-client.js).
 */
export const FIREFOX_GONE_AFTER_MS = 45_000;

let canOpen: Promise<boolean> | null = null;
/** Whether Codara can open about:debugging in the user's Firefox on this computer; asked once. */
export function useCanOpenFirefoxDebugging(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    let alive = true;
    const api = window.spark?.chromeLink;
    if (!api?.canOpenFirefoxDebugging) return;
    canOpen ??= api.canOpenFirefoxDebugging().catch(() => false);
    void canOpen.then((value) => {
      if (alive) setCan(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return can;
}

/** Open about:debugging in Firefox where Codara can, else copy its address; and copy the manifest.json path. */
export function FirefoxLoadActions({ onError }: { onError?: (message: string) => void }): React.ReactElement {
  const canOpenPage = useCanOpenFirefoxDebugging();
  const [done, setDone] = useState<string | null>(null);
  const act = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action();
      setDone(what);
      setTimeout(() => setDone((current) => (current === what ? null : current)), 1500);
    } catch (failure) {
      onError?.(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <>
      {canOpenPage ? (
        <button
          type="button"
          className="spark-btn is-primary"
          title={OPEN_IN_FIREFOX_TITLE}
          onClick={() => void act("open", async () => {
            if (!(await window.spark.chromeLink.openFirefoxDebugging())) throw new Error(`Codara could not start Firefox: open ${FIREFOX_DEBUGGING_ADDRESS} in it yourself.`);
          })}
        >
          {done === "open" ? "Opened in Firefox" : "Open in Firefox"}
        </button>
      ) : (
        <button type="button" className="spark-btn" onClick={() => void act("address", () => navigator.clipboard.writeText(FIREFOX_DEBUGGING_ADDRESS))}>
          {done === "address" ? "Copied" : "Copy the page address"}
        </button>
      )}
      <button
        type="button"
        className="spark-btn"
        onClick={() => void act("manifest", async () => navigator.clipboard.writeText(await window.spark.chromeLink.prepareFirefoxManifest()))}
      >
        {done === "manifest" ? "Copied" : "Copy manifest.json path"}
      </button>
    </>
  );
}

/** Why it is a developer add-on, and the browsers that keep it, in one sentence. */
export function FirefoxWhyNote(): React.ReactElement {
  return (
    <p className="chrome-connect__d">
      Why: Mozilla's add-on site does not take add-ons that let an agent run scripts in pages, so Codara's is loaded as a developer
      add-on. Firefox Developer Edition, Nightly or ESR can keep it across restarts:{" "}
      <button type="button" className="chrome-connect__link" onClick={() => void window.spark.openInSystemBrowser(FIREFOX_INSTALL_DOCS)}>
        how
      </button>
      .
    </p>
  );
}

/** The paired Firefoxes that dropped and stayed away goneAfterMs (firefox-gone.ts), by linkId. */
export function useGoneFirefoxes(state: ChromeLinkState | null, goneAfterMs = FIREFOX_GONE_AFTER_MS): string[] {
  const [gone, setGone] = useState<string[]>([]);
  const tracker = useRef<GoneFirefoxTracker | null>(null);
  useEffect(() => {
    const created = new GoneFirefoxTracker(goneAfterMs, setGone);
    tracker.current = created;
    return () => {
      created.dispose();
      tracker.current = null;
    };
  }, [goneAfterMs]);
  useEffect(() => {
    tracker.current?.update(state?.browsers ?? []);
  }, [state, goneAfterMs]);
  return gone;
}

/**
 * After a paired Firefox closed or restarted, one quiet notice with how to
 * load the add-on again. Dismissed, it stays away until that Firefox
 * connects and drops again. Not while the connect card is on screen: the
 * card says the same.
 */
export default function FirefoxReloadNotice(): React.ReactElement | null {
  const state = useChromeLink();
  const gone = useGoneFirefoxes(state);
  const cardShown = useConnectCardShown();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Back connected: a later drop is a new one.
  useEffect(() => setDismissed((list) => list.filter((id) => gone.includes(id))), [gone]);
  const shown = gone.filter((id) => !dismissed.includes(id));
  if (shown.length === 0 || cardShown) return null;
  return (
    <section role="status" aria-label="Load the Codara add-on in Firefox again" data-firefox-reload="" className="spark-glass--strong spark-overlay-surface chrome-pairing chrome-pairing--notice">
      <div className="chrome-pairing__title">Load Codara in Firefox again</div>
      <p className="chrome-pairing__body">
        Firefox closed or restarted, which removes the Codara add-on. In its <strong>This Firefox</strong> page choose{" "}
        <strong>Load Temporary Add-on</strong> and pick manifest.json (paste its path into the file dialog). It keeps its pairing and connects
        by itself.
      </p>
      {error ? <div className="chrome-connect__error" role="alert">{error}</div> : null}
      <div className="chrome-pairing__actions">
        <FirefoxLoadActions onError={setError} />
        <button
          type="button"
          className="spark-btn"
          onClick={() => window.dispatchEvent(new CustomEvent("spark:open-settings", { detail: { section: "browser" } }))}
        >
          Settings
        </button>
        <button type="button" className="spark-btn" onClick={() => setDismissed((list) => [...list, ...shown])}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
