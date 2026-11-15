// A file on this computer named by its path where the browser expects a URL:
// typed in the address bar, or passed by an agent to codara_preview_navigate.
// Chromium takes only URLs: webview.loadURL rejects a bare path without a
// sound, and a new tab's src resolves it against Studio's own page, which
// under `npm run dev` is the Vite server, so the tab shows Studio itself.
// Callers turn the path this returns into a file:// URL.

/**
 * The absolute path `raw` names, or null when it is not a local path (a URL,
 * a host, a port, a relative name). `~` and `~/...` expand to `home`; with
 * no home known they stay null. `drives` takes `C:\...` and `C:/...` as
 * Windows drive paths; main passes false off Windows, where node would read
 * one as a name relative to the working folder.
 */
export function localFilePath(raw: string, home: string | null, drives = true): string | null {
  const text = raw.trim();
  if (/^~(?=$|[\\/])/.test(text)) return home ? home.replace(/[\\/]+$/, "") + text.slice(1) : null;
  // "//host/x" is a protocol-relative URL, not a path.
  if (/^\/(?!\/)/.test(text)) return text;
  if (drives && /^[A-Za-z]:[\\/]/.test(text)) return text;
  return null;
}
