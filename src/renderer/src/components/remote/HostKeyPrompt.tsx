import { useEffect, useRef, useState } from "react";
import type { HostKeyPromptRequest } from "@shared/remote";

// Asks before Codara connects to a machine whose key it has never seen and
// your ~/.ssh/known_hosts does not list (src/main/remote/connections.ts).
// Mounted once near the App root, like RemoteAuthPrompt. Prompts arrive one
// handshake at a time, so a queue keeps a second one from replacing the first.
export default function HostKeyPrompt() {
  const [queue, setQueue] = useState<HostKeyPromptRequest[]>([]);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const request = queue[0] ?? null;

  useEffect(() => window.spark.remote.onHostKeyPrompt((req) => setQueue((current) => [...current, req])), []);
  useEffect(
    () =>
      window.spark.remote.onHostKeyPromptClosed((requestId) =>
        setQueue((current) => current.filter((queued) => queued.requestId !== requestId)),
      ),
    [],
  );

  useEffect(() => {
    // Focus starts on the safe answer: Enter must not trust a key by accident.
    if (request) cancelRef.current?.focus();
  }, [request]);

  if (!request) return null;

  const answer = (trust: boolean) => {
    window.spark.remote.answerHostKeyPrompt({ requestId: request.requestId, trust });
    setQueue((current) => current.filter((queued) => queued.requestId !== request.requestId));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Is this ${request.hostId}?`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 400,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Sibling scrim, never a backdrop-filter here: see RemoteAuthPrompt.
        background: "transparent",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") answer(false);
      }}
    >
      <div className="spark-scrim" style={{ position: "absolute", inset: 0, zIndex: 0 }} />
      <div
        className="spark-glass--strong spark-overlay-surface"
        style={{
          position: "relative",
          zIndex: 1,
          width: 460,
          maxWidth: "90vw",
          padding: 20,
          borderRadius: 12,
          display: "grid",
          gap: 12,
        }}
      >
        <div className="spark-eyebrow" style={{ color: "var(--accent-text)" }}>
          SSH · {request.hostId}
        </div>
        <div style={{ fontSize: 14, color: "var(--ink)", fontWeight: 600 }}>Is this {request.hostId}?</div>
        <div style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.5 }}>
          Codara has not connected to {request.hostLabel} before, and your SSH known_hosts does not list it. Check
          that this fingerprint is the machine's before you trust it. On the machine,{" "}
          <code>ssh-keygen -lf /etc/ssh/ssh_host_{keyFileName(request.keyType)}_key.pub</code> prints it.
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--ink)",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--rule)",
            background: "var(--panel)",
            wordBreak: "break-all",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: 11 }} data-host-key-type={request.keyType}>
            {request.keyType}
          </div>
          {request.fingerprint}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button ref={cancelRef} type="button" className="spark-btn" onClick={() => answer(false)}>
            Don't connect
          </button>
          <button type="button" className="spark-btn is-primary" onClick={() => answer(true)}>
            Trust and connect
          </button>
        </div>
      </div>
    </div>
  );
}

/** ssh-ed25519 → ed25519, ecdsa-sha2-nistp256 → ecdsa, ssh-rsa → rsa. */
function keyFileName(keyType: string): string {
  if (keyType.includes("ed25519")) return "ed25519";
  if (keyType.startsWith("ecdsa")) return "ecdsa";
  if (keyType.includes("rsa")) return "rsa";
  return "*";
}
