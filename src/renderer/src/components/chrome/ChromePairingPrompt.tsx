import React, { useState } from "react";

import { useChromeLink } from "./useChromeLink";
import "./chrome-link.css";

/**
 * A browser asked to connect: show its code beside Allow and Deny, wherever
 * the user is in Codara. The same code shows in the extension's popup, so
 * the user can tell their own browser from anything else asking.
 */
export default function ChromePairingPrompt(): React.ReactElement | null {
  const state = useChromeLink();
  const [busy, setBusy] = useState(false);
  const pairing = state?.pending[0];
  if (!pairing) return null;

  const decide = async (allow: boolean) => {
    setBusy(true);
    try {
      if (allow) await window.spark.chromeLink.approve(pairing.id);
      else await window.spark.chromeLink.deny(pairing.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      role="dialog"
      aria-label="Connect a browser to Codara"
      data-chrome-pairing={pairing.id}
      className="spark-glass--strong spark-overlay-surface chrome-pairing"
    >
      <div className="chrome-pairing__title">{pairing.browser.name} wants to connect</div>
      <p className="chrome-pairing__body">
        Allow it only if the Codara extension in your browser shows this code. Agents then use only
        the tabs you share from its popup.
      </p>
      <div className="chrome-pairing__code spark-mono" aria-label="Pairing code">
        {pairing.code}
      </div>
      <div className="chrome-pairing__actions">
        <button type="button" className="spark-btn" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </button>
        <button type="button" className="spark-btn is-primary" disabled={busy} onClick={() => void decide(true)}>
          Allow
        </button>
      </div>
    </section>
  );
}
