// ── Privileged-channel sender gating + trusted main-window tracking ─────────
// Almost every privileged IPC channel (src/main/ipc.ts) can spawn processes,
// run arbitrary shell commands, enable remote access, widen the filesystem
// sandbox, write arbitrary paths, drive git in an arbitrary cwd, or mutate
// preferences. Those must only ever be driven by the app's own trusted
// renderer, never by attacker-controlled content that somehow became a frame of
// a window (or by a preview <webview> guest).
//
// This module owns the single source of truth for "who is the trusted main
// window, and is the document currently living in its main frame one the
// navigation allowlist accepts". ipc.ts, index.ts, and the preview/terminal
// bridges all key their sender checks off the predicates exported here, so the
// trust decision lives in exactly one place. It is kept deliberately small and
// free of any dependency on the rest of the IPC surface so it can be bundled
// and exercised against a real Electron window in isolation
// (scripts/test-trusted-sender.cjs imports the real predicates from here).
//
// requireTrustedSender proves the sender is the main window's CURRENT main
// frame, and that the document living in that frame arrived by a COMMITTED
// navigation the allowlist accepts:
//   1. Frame identity: event.senderFrame must be the exact
//      mainWindow.webContents.mainFrame object (re-read per call). This rejects
//      subframes (a different RenderFrame) and <webview> guests (a different
//      webContents' main frame) robustly, without relying on a URL string.
//   2. Trusted document: a boolean maintained from `did-navigate` /
//      `did-frame-navigate` (see registerTrustedMainWindow). It is recomputed
//      from the COMMITTED url via isAllowedMainWindowUrl, and deliberately NOT
//      updated on `did-navigate-in-page`, so history.pushState / location.hash
//      cannot forge it: a rewritten in-page URL fires no committed-navigation
//      event and leaves the flag untouched.
// We deliberately do NOT read event.senderFrame.url: a frame's URL is
// renderer-writable state (pushState rewrites it with no navigation), so it is
// not an identity. The navigation guard in index.ts keeps using the predicate
// for what it is good at (deciding which URLs may commit); this gate keys off
// the RESULT of that guard, not a live URL read.

import { app, type BrowserWindow, type WebContents } from "electron";
import { join } from "node:path";
import { logMain } from "./file-log";
import {
  isAllowedMainWindowUrl,
  resolveMainWindowAllowlistConfig,
  type NavigationAllowlistConfig,
} from "./navigation-allowlist";

// The default allowlist config: derived from the same source of truth the
// window loader uses. Passed as the resolver to registerTrustedMainWindow in
// production; the sender-gate test injects its own resolver so it can point the
// allowlist at a synthetic renderer entry.
function defaultAllowlistConfig(): NavigationAllowlistConfig {
  return resolveMainWindowAllowlistConfig({
    isPackaged: app.isPackaged,
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL,
    rendererEntryPath: join(__dirname, "../renderer/index.html"),
  });
}

// The privileged main window and whether its currently-committed main-frame
// document passed the allowlist. Both start empty and fail closed: until the
// first committed navigation is evaluated, no gated channel is trusted.
let trustedWindow: BrowserWindow | null = null;
let trustedDocumentCommitted = false;
// Resolved once per window at registration time; read by evaluateCommit as each
// committed navigation lands. Held in module scope (not just a closure) so the
// resolved allowlist is the single value the commit evaluation keys off.
let allowlistConfig: NavigationAllowlistConfig | null = null;

// The <webview> guests currently attached to the trusted main window, mapped to
// their host webContents id. Populated from `did-attach-webview` on the trusted
// window, which fires in the main process when Chromium actually attaches a
// guest, so it cannot be forged by renderer-supplied ids. The preview
// computer-use executor validates a resolved webContentsId against this before
// it drives the guest with CDP / executeJavaScript, so a forged id can never
// steer main into attaching the DevTools protocol to an arbitrary webContents.
const previewGuestHosts = new Map<number, number>();

export function getTrustedMainWindow(): BrowserWindow | null {
  if (!trustedWindow || trustedWindow.isDestroyed()) return null;
  return trustedWindow;
}

// Wire the trust tracker to a freshly-created main window. Called from
// index.ts createWindow() immediately after `new BrowserWindow(...)` and BEFORE
// the initial loadURL/loadFile, so the very first committed navigation (which
// fires no will-navigate but DOES fire did-navigate) is evaluated. A renderer
// can only run its preload/scripts, and therefore only send its first
// ipcRenderer.invoke, AFTER the document commits, so did-navigate (emitted
// synchronously in the main process at commit) is always processed before the
// first gated invoke: the fail-closed initial state cannot deadlock legitimate
// startup IPC.
//
// `resolveConfig` defaults to the production allowlist; the sender-gate test
// injects one pointing at its synthetic renderer entry.
export function registerTrustedMainWindow(
  win: BrowserWindow,
  resolveConfig: () => NavigationAllowlistConfig = defaultAllowlistConfig,
): void {
  trustedWindow = win;
  trustedDocumentCommitted = false;
  allowlistConfig = resolveConfig();
  // A new window starts with no known guests; drop any stragglers recorded for
  // a previous window so the map never validates a stale id.
  previewGuestHosts.clear();
  const wc = win.webContents;
  const evaluateCommit = (url: string, isMainFrame: boolean): void => {
    // A stale listener from a previous window must never move the global flag
    // for the current one. All current teardown paths destroy the old window
    // first, so this is latent, but the guard closes it permanently.
    if (trustedWindow !== win) return;
    // Only the top frame's committed document decides trust; subframe commits
    // never move it.
    if (!isMainFrame) return;
    trustedDocumentCommitted = isAllowedMainWindowUrl(url, allowlistConfig ?? resolveConfig());
  };
  // did-navigate is the main-frame committed-navigation signal (initial load,
  // reload, and crash-recovery reload all fire it). did-frame-navigate covers
  // every frame; we act on it only for the main frame. did-navigate-in-page is
  // intentionally NOT observed: an in-page URL rewrite (pushState / hash) must
  // not change trust.
  wc.on("did-navigate", (_e, url) => evaluateCommit(url, true));
  wc.on("did-frame-navigate", (_e, url, _httpResponseCode, _httpStatusText, isMainFrame) =>
    evaluateCommit(url, isMainFrame),
  );
  // A main-frame load FAILURE commits Chromium's error page WITHOUT firing
  // did-navigate / did-frame-navigate (DidFinishNavigation skips both when
  // IsErrorPage()), so evaluateCommit never runs and trustedDocumentCommitted
  // would keep its old value: a fail-OPEN hole in a fail-closed mechanism. Clear
  // it here so a non-allowlisted document that arrived via an error commit can
  // never inherit the previous document's trust. ERR_ABORTED (-3) is a benign
  // reload/navigation race, not a committed error page (index.ts's boot watchdog
  // skips it for the same reason); ignore it so a prevented will-navigate
  // hand-off does not transiently drop trust. The flag is only ever re-set to
  // true by a real allowlisted commit.
  wc.on("did-fail-load", (_e, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (trustedWindow !== win) return;
    if (!isMainFrame || errorCode === -3) return;
    trustedDocumentCommitted = false;
  });
  // Record every <webview> guest Chromium attaches to this window so the
  // preview executor can prove a webContentsId is a real guest of the main
  // window before driving it. The guest's own 'destroyed' clears its entry.
  wc.on("did-attach-webview", (_e, guest) => {
    if (trustedWindow !== win) return;
    const guestId = guest.id;
    previewGuestHosts.set(guestId, wc.id);
    guest.once("destroyed", () => {
      if (previewGuestHosts.get(guestId) === wc.id) previewGuestHosts.delete(guestId);
    });
  });
  wc.on("destroyed", () => {
    if (trustedWindow === win) {
      trustedWindow = null;
      trustedDocumentCommitted = false;
      allowlistConfig = null;
      previewGuestHosts.clear();
    }
  });
}

// Shared core for both the invoke gate (which throws) and the ipcMain.on gate
// (which must NOT throw: an uncaught throw inside an 'on' handler crashes the
// main process, whereas invoke handlers turn a throw into a rejected promise).
// Returns a short reason code when the sender is not trusted, or null when it
// is. Reason codes never carry a URL, path, or key: they only distinguish
// "wrong frame" from "right frame, untrusted document" so a real self-DoS (e.g.
// an accidental router that starts committing out-of-allowlist URLs) is
// diagnosable without leaking user data.
export function untrustedSenderReason(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
): string | null {
  const win = trustedWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return "no-window";
  // Re-read mainFrame per call: a cross-document navigation swaps the frame
  // object, and we must compare against the CURRENT one, not a captured handle.
  const mainFrame = win.webContents.mainFrame;
  const frame = event.senderFrame;
  if (!frame || frame !== mainFrame) return "not-main-frame";
  if (!trustedDocumentCommitted) return "untrusted-document";
  return null;
}

// The invoke gate: throws (rejecting the renderer's promise) when the sender is
// not the trusted main frame. Logs a single line with a short reason code and
// no URL, path, or key material.
export function requireTrustedSender(event: Electron.IpcMainInvokeEvent, channel: string): void {
  const reason = untrustedSenderReason(event);
  if (reason) {
    logMain("security", `blocked privileged channel ${channel} from untrusted sender (${reason})`);
    throw new Error(`Blocked: ${channel} is not available to this sender.`);
  }
}

// The ipcMain.on counterpart: logs and returns false (never throws) so callers
// can early-return. Used to gate the handful of fire-and-forget 'on' channels.
export function isTrustedOnSender(event: Electron.IpcMainEvent, channel: string): boolean {
  const reason = untrustedSenderReason(event);
  if (reason) {
    logMain("security", `blocked privileged channel ${channel} from untrusted sender (${reason})`);
    return false;
  }
  return true;
}

// True only when `wc` is a live <webview> guest that Chromium attached to the
// trusted main window. Used by the preview computer-use executor to reject a
// webContentsId that did not come from a genuine preview guest of this window,
// before it attaches the DevTools protocol / runs executeJavaScript against it.
export function isTrustedPreviewGuest(wc: WebContents | null | undefined): boolean {
  if (!wc || wc.isDestroyed()) return false;
  const win = getTrustedMainWindow();
  if (!win || win.webContents.isDestroyed()) return false;
  // A guest is a <webview>; the main frame itself, other windows, DevTools, and
  // background pages are not, so this rejects them even if their id were mapped.
  if (wc.getType() !== "webview") return false;
  return previewGuestHosts.get(wc.id) === win.webContents.id;
}
