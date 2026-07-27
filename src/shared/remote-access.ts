// Shared types for phone Remote Access (docs/remote-access.md), phase 1.
// This is the renderer-facing surface only: status for the Settings panel,
// paired-device summaries, and the pairing modal's live state. The wire
// protocol (RPC v0 frames) lives in src/main/remote-access/rpc.ts and is
// deliberately not exported to the renderer, which never speaks it. The
// pairing QR payload crosses IPC as an opaque string the renderer renders
// into a QR image and must not parse.

// Lifecycle of the always-on listener. "reachable" means the local listener
// is up; `dhtReady` says whether the DHT announce also succeeded, so the UI
// can distinguish LAN-only reachability from world reachability without a
// separate state.
export type RemoteAccessState = "disabled" | "starting" | "reachable" | "error";

export interface RemoteAccessStatus {
  state: RemoteAccessState;
  // Plain-language reason, only meaningful for "error"; empty otherwise.
  detail: string;
  // TCP port the direct (LAN/WAN) listener is bound to, null when down.
  port: number | null;
  // True when the DHT server is announced under the computer's key, so
  // paired devices can also reach us from outside the LAN.
  dhtReady: boolean;
}

// One row of the Settings panel's paired-devices list. `publicKey` is the
// full canonical padded base64 key (the revoke handle); `shortKey` is the
// only form meant for display and logs (first 8 chars), per the rule that
// full keys never show up where they could be confused for secrets.
export interface RemotePairedDevice {
  publicKey: string;
  shortKey: string;
  name: string;
  // Epoch milliseconds.
  addedAt: number;
  lastSeenAt: number | null;
}

// Returned by remote:startPairing. `qrPayload` is the exact JSON string to
// encode into the QR image; `expiresAt` (epoch ms) lets the modal count down
// and flip to "expired" without another IPC round trip.
export interface RemotePairingSession {
  qrPayload: string;
  expiresAt: number;
}

// Pushed to the renderer while the pairing modal is open. "paired" carries
// the new device's name so the modal can show a success state.
export type RemotePairingState =
  | { phase: "idle" }
  | { phase: "waiting"; expiresAt: number }
  | { phase: "paired"; deviceName: string }
  | { phase: "expired" };
