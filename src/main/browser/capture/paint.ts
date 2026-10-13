// Keeps a background Codara tab painting while a protocol capture runs.
// Chromium produces no compositor frames for a <webview> whose host is
// hidden, so a full-page capture, a size sweep or a screencast of a tab the
// user is not looking at would wait forever. The pane that owns the guest
// takes a paint lease (capturePaint.ts in the renderer) and acknowledges it;
// a guest no pane claims, or a Chrome tab, captures without one.

import { ipcMain } from "electron";

import type { CaptureGuestPaintAck, CaptureGuestPaintRequest } from "../../../shared/capture";
import { getTrustedMainWindow, isTrustedOnSender } from "../../main-window-trust";
import type { CdpSession } from "../cdp-session";

export const GUEST_PAINT_CHANNEL = "capture:guest-paint";
export const GUEST_PAINT_ACK_CHANNEL = "capture:guest-paint-ack";

const PREVIEW_KEY = /^preview-guest:(\d+)$/;
const ACK_TIMEOUT_MS = 1_500;

const pending = new Map<string, (held: boolean) => void>();
let sequence = 0;
let listening = false;

type Send = (request: CaptureGuestPaintRequest) => boolean;

let sendOverride: Send | null = null;

/** Tests route requests through their own fake window. */
export function setGuestPaintTransport(send: Send | null): void {
  sendOverride = send;
}

export function acknowledgeGuestPaint(ack: CaptureGuestPaintAck): void {
  const settle = pending.get(ack?.reqId);
  if (!settle) return;
  pending.delete(ack.reqId);
  settle(ack.held === true);
}

function send(request: CaptureGuestPaintRequest): boolean {
  if (sendOverride) return sendOverride(request);
  try {
    const window = getTrustedMainWindow();
    if (!window || window.isDestroyed()) return false;
    if (!listening) {
      ipcMain.on(GUEST_PAINT_ACK_CHANNEL, (event, ack: CaptureGuestPaintAck) => {
        if (isTrustedOnSender(event, GUEST_PAINT_ACK_CHANNEL)) acknowledgeGuestPaint(ack);
      });
      listening = true;
    }
    window.webContents.send(GUEST_PAINT_CHANNEL, request);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the owning pane to keep the guest painting; resolves with the
 * release once the pane holds it, or with a no-op when no pane answers.
 */
export async function holdGuestPaint(session: Pick<CdpSession, "key">): Promise<() => void> {
  const match = PREVIEW_KEY.exec(session.key);
  if (!match) return () => {};
  const webContentsId = Number(match[1]);
  const reqId = `paint-${++sequence}`;
  const held = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve(false);
    }, ACK_TIMEOUT_MS);
    pending.set(reqId, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    if (!send({ reqId, webContentsId, hold: true })) {
      clearTimeout(timer);
      pending.delete(reqId);
      resolve(false);
    }
  });
  if (!held) return () => {};
  let released = false;
  return () => {
    if (released) return;
    released = true;
    send({ reqId, webContentsId, hold: false });
  };
}

export async function withGuestPaint<T>(session: Pick<CdpSession, "key">, run: () => Promise<T>): Promise<T> {
  const release = await holdGuestPaint(session);
  try {
    return await run();
  } finally {
    release();
  }
}
