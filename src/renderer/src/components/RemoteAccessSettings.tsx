import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type {
  RemoteAccessStatus,
  RemotePairedDevice,
  RemotePairingState,
} from "@shared/remote-access";
import {
  EmptyState,
  InlineMessage,
  SettingRow,
  SettingsCard,
  SettingsSection,
  SwitchTrack,
} from "./settings/SettingsPrimitives";

// Settings, "Remote access": the phone companion's listener toggle, a live
// status line, QR pairing, and the paired-device list with revoke
// (docs/remote-access.md phase 1). The renderer holds no key material - it
// receives a status object, device summaries, and an opaque QR payload
// string it only ever renders into an image.

const QR_PIXEL_SIZE = 640;
const QR_DISPLAY_SIZE = 260;

function statusLine(status: RemoteAccessStatus): { text: string; tone: "muted" | "ok" | "bad" } {
  switch (status.state) {
    case "disabled":
      return { text: "Off. Paired devices cannot reach this computer.", tone: "muted" };
    case "starting":
      return { text: "Starting the listener...", tone: "muted" };
    case "reachable":
      return status.relayReady
        ? { text: "Reachable on your network and from anywhere.", tone: "ok" }
        : {
            text: "Reachable on your local network. The cellular relay is reconnecting.",
            tone: "muted",
          };
    case "error":
      return { text: status.detail || "Remote access could not start.", tone: "bad" };
  }
}

function formatWhen(epochMs: number | null): string {
  if (!epochMs) return "never";
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString();
}

export default function RemoteAccessSettings() {
  const [status, setStatus] = useState<RemoteAccessStatus>({
    state: "disabled",
    detail: "",
    port: null,
    relayReady: false,
  });
  const [devices, setDevices] = useState<RemotePairedDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await window.spark.remoteAccess.listDevices());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await window.spark.remoteAccess.getStatus();
        if (!cancelled) setStatus(current);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
      await refreshDevices();
    })();
    const off = window.spark.remoteAccess.onStatusChanged((next) => setStatus(next));
    return () => {
      cancelled = true;
      off();
    };
  }, [refreshDevices]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.spark.remoteAccess.setEnabled(next));
      if (!next) setPairingOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (device: RemotePairedDevice) => {
    setBusy(true);
    setError(null);
    try {
      setDevices(await window.spark.remoteAccess.revokeDevice(device.publicKey));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enabled = status.state !== "disabled";
  const line = statusLine(status);
  const toneClass =
    line.tone === "ok" ? "st-text-ok" : line.tone === "bad" ? "st-text-danger" : undefined;

  return (
    <>
      <SettingsSection
        title="Connection"
        anchor="Allow remote access"
        description="Let the Codara phone app reach this computer, on your wifi or from anywhere. Devices pair by QR code, and you can revoke them at any time."
      >
        <SettingRow
          title="Allow remote access"
          desc={
            <span className={toneClass}>
              {status.state === "reachable" && line.tone === "ok" ? (
                <span aria-hidden className="st-live-dot" />
              ) : null}
              {line.text}
            </span>
          }
          control={
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Remote access"
              className="st-switch-btn"
              disabled={busy}
              onClick={() => void toggle(!enabled)}
            >
              <SwitchTrack checked={enabled} />
            </button>
          }
        />
        {status.state === "reachable" ? (
          <SettingRow
            title="Pair a new device"
            desc={<span className="spark-mono">port {status.port}</span>}
            control={
              <button
                type="button"
                className="spark-btn is-primary"
                disabled={busy}
                onClick={() => setPairingOpen(true)}
              >
                Pair a device
              </button>
            }
          />
        ) : null}
        {error ? (
          <InlineMessage tone="danger" role="alert">{error}</InlineMessage>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Paired devices"
        description="A paired device can open terminals on this computer. Revoking one ends its live sessions at once."
        plain
      >
        {devices.length === 0 ? (
          <SettingsCard>
            <EmptyState
              icon={
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="7" y="3" width="10" height="18" rx="2.5" />
                  <line x1="10.5" y1="17.5" x2="13.5" y2="17.5" />
                </svg>
              }
              title="No paired devices yet."
              body={
                enabled
                  ? "Choose Pair a device above, then scan the code with the Codara app."
                  : "Turn on remote access above, then pair your phone by scanning a QR code."
              }
            />
          </SettingsCard>
        ) : (
          <div className="st-list">
            {devices.map((device) => (
              <div key={device.publicKey} className="st-list__row st-device">
                <span aria-hidden className="st-device__icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="7" y="3" width="10" height="18" rx="2.5" />
                    <line x1="10.5" y1="17.5" x2="13.5" y2="17.5" />
                  </svg>
                </span>
                <div className="st-device__text">
                  <div className="st-device__name">{device.name}</div>
                  <div className="st-device__meta">
                    <span className="spark-mono">{device.shortKey}</span>
                    {`, paired ${formatWhen(device.addedAt)}, last seen ${formatWhen(device.lastSeenAt)}`}
                  </div>
                </div>
                <button
                  type="button"
                  className="spark-btn is-danger"
                  disabled={busy}
                  onClick={() => void revoke(device)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {pairingOpen ? (
        <PairingModal
          onClose={() => {
            // Cancelling the pairing window is the modal's own unmount
            // cleanup, not this callback: the whole Settings dialog can be
            // dismissed (Escape, Done, a workspace switch) without this ever
            // running, and a pairing window left open would keep accepting
            // strangers for the rest of its TTL with no UI on screen.
            setPairingOpen(false);
            void refreshDevices();
          }}
        />
      ) : null}
    </>
  );
}

// The pairing modal owns one pairing window for its whole lifetime: it
// starts one on mount and cancels it in the mount effect's CLEANUP, so
// every way of dismissing it (including ones that never call onClose, like
// the Settings dialog closing underneath it) closes the listener's
// stranger window too.
function PairingModal({ onClose }: { onClose: () => void }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<RemotePairingState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [deciding, setDeciding] = useState(false);

  // Approving is the moment a device becomes trusted, so both decisions cross
  // their own main-process channels rather than riding on the pairing state.
  // On success the authoritative answer still arrives as a pairing state change,
  // so we leave the buttons disabled and wait for it. A rejection is NOT
  // swallowed: it can mean the privileged-IPC gate denied the call (an untrusted
  // sender), not only that the window is gone, so surface it and re-enable the
  // buttons rather than leaving the modal stuck in pending-approval forever.
  const decide = async (action: "approve" | "deny") => {
    setDeciding(true);
    setError(null);
    try {
      await (action === "approve"
        ? window.spark.remoteAccess.approvePairing()
        : window.spark.remoteAccess.denyPairing());
    } catch (err) {
      setError((err as Error).message);
      setDeciding(false);
    }
  };
  const approve = () => void decide("approve");
  const deny = () => void decide("deny");
  useEffect(() => {
    // No mount guard here on purpose. Under StrictMode's dev double-invoke
    // the sequence is start, cleanup-cancel, start again; a ref that latched
    // on the first start would suppress the second one and leave the modal
    // stuck on "Generating..." with no pairing window open. Starting twice
    // is safe instead: startPairing replaces any existing window, so the
    // steady state is still exactly one.
    let cancelled = false;
    void (async () => {
      try {
        const session = await window.spark.remoteAccess.startPairing();
        if (cancelled) return;
        const dataUrl = await QRCode.toDataURL(session.qrPayload, {
          width: QR_PIXEL_SIZE,
          margin: 1,
          errorCorrectionLevel: "M",
        });
        if (cancelled) return;
        setQrDataUrl(dataUrl);
        setPhase({ phase: "waiting", expiresAt: session.expiresAt });
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      // Any unmount closes the pairing window, however the modal went away
      // (Escape, scrim, the whole Settings dialog closing, a workspace
      // switch). Harmless when pairing already succeeded: the main process
      // closed the window itself at that point.
      void window.spark.remoteAccess.cancelPairing().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const off = window.spark.remoteAccess.onPairingChanged((next) => {
      setPhase(next);
      // A fresh request to decide re-enables the approve/deny buttons and clears
      // any error left over from a prior decision that failed.
      if (next.phase === "pending-approval") {
        setDeciding(false);
        setError(null);
      }
    });
    return off;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // On document, so it runs before Settings' window listener; marking the
  // Escape handled keeps Settings open underneath and closes only this.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const secondsLeft = useMemo(() => {
    if (phase.phase !== "waiting") return 0;
    return Math.max(0, Math.ceil((phase.expiresAt - now) / 1000));
  }, [phase, now]);

  // The scrim deliberately does nothing, as in Settings and the Capability
  // Center: a stray click outside must not drop a QR code mid-pairing. Only
  // Escape and the modal's own buttons close it.
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div className="spark-scrim" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Pair a device"
        // An opaque reading face like the Settings pane it opens from: a QR
        // code and a fingerprint to compare must not sit on see-through
        // glass, and the Settings face under it already is glass.
        className="st-pair-modal"
        style={{
          zIndex: 1,
          width: "min(400px, calc(100vw - 60px))",
          borderRadius: 12,
          padding: 20,
          display: "grid",
          gap: 14,
          justifyItems: "center",
          textAlign: "center",
          animation: "spark-fade-in var(--motion) var(--ease-out)",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {phase.phase === "pending-approval" ? (
          <>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Approve this device?</div>
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600, color: "var(--fg, inherit)" }}>{phase.deviceName}</span>{" "}
              wants to pair. Approve it only if this matches the device in your hand, and the code
              below matches the one it is showing.
            </div>
            <div
              className="spark-mono"
              style={{
                fontSize: 15,
                letterSpacing: "0.12em",
                padding: "8px 12px",
                borderRadius: 8,
                background: "var(--surface-2, rgba(127,127,127,0.12))",
              }}
            >
              {phase.fingerprint}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="spark-btn" disabled={deciding} onClick={deny}>
                Deny
              </button>
              <button type="button" className="spark-btn is-primary" disabled={deciding} onClick={approve}>
                Approve
              </button>
            </div>
            {error ? (
              <div style={{ fontSize: 12, color: "var(--danger, #f87171)", lineHeight: 1.5 }}>
                {error}
              </div>
            ) : null}
          </>
        ) : phase.phase === "paired" ? (
          <>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Paired</div>
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
              {phase.deviceName} can now reach this computer. Revoke it any time from Settings.
            </div>
            <button type="button" className="spark-btn is-primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : phase.phase === "denied" ? (
          <>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Pairing refused</div>
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
              No device was added. Close this and start again if you meant to approve it.
            </div>
            <button type="button" className="spark-btn" onClick={onClose}>
              Close
            </button>
          </>
        ) : phase.phase === "expired" ? (
          <>
            <div style={{ fontSize: 15, fontWeight: 600 }}>This code expired</div>
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
              Pairing codes last two minutes. Close this and start again for a fresh code.
            </div>
            <button type="button" className="spark-btn" onClick={onClose}>
              Close
            </button>
          </>
        ) : error ? (
          <>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Could not start pairing</div>
            <div style={{ fontSize: 12, color: "var(--danger, #f87171)", lineHeight: 1.5 }}>{error}</div>
            <button type="button" className="spark-btn" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Scan with the Codara app</div>
            <div
              style={{
                width: QR_DISPLAY_SIZE,
                height: QR_DISPLAY_SIZE,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                // White plate behind the code: scanners need the quiet zone
                // and the light modules regardless of the app theme.
                background: "#ffffff",
                borderRadius: 8,
                padding: 8,
              }}
            >
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Pairing QR code"
                  style={{ width: "100%", height: "100%", imageRendering: "pixelated" }}
                />
              ) : (
                <span style={{ fontSize: 12, color: "#666" }}>Generating...</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
              Both devices must be on the same wifi for pairing. This code works once and
              expires in {secondsLeft}s.
            </div>
            <button type="button" className="spark-btn" onClick={onClose}>
              Cancel
            </button>
          </>
        )}
      </section>
    </div>
  );
}
