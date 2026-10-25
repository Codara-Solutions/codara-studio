// The browser pane's tabs and memory view and its full screen.
//
// Memory: each tab's page runs in its own renderer process, found through
// the guest bound to the tab (preview-cdp.ts). On Linux the figure is the
// process's proportional set size, which splits shared pages between the
// processes that map them, so tabs add up to what they really cost; the
// resident size elsewhere.
//
// Full screen: the pane fills the window in the renderer; "display" also
// makes the window full screen. While a tab is full screen, Escape typed in
// its page reaches the app so it can leave (guest-chords.ts).

import { readFile } from "node:fs/promises";

import { app, BrowserWindow, webContents } from "electron";

import type { BrowserFullScreenRequest, BrowserTabMemory } from "../../shared/browser-tabs";
import type { IpcHandle } from "../ipc";
import { setGuestFullScreen } from "./guest-chords";
import { previewTabGuests } from "./preview-cdp";

async function proportionalBytes(pid: number): Promise<number | null> {
  if (process.platform !== "linux") return null;
  try {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const match = /^Pss:\s+(\d+)\s+kB/m.exec(text);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function processBytes(pid: number, workingSetKb: number): Promise<number> {
  return (await proportionalBytes(pid)) ?? workingSetKb * 1024;
}

export async function readBrowserTabMemory(): Promise<BrowserTabMemory> {
  const metrics = app.getAppMetrics();
  const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));
  const bytesByPid = new Map<number, number>();
  await Promise.all(
    metrics.map(async (metric) => {
      bytesByPid.set(metric.pid, await processBytes(metric.pid, metric.memory.workingSetSize));
    }),
  );
  const tabs: Record<string, number> = {};
  for (const [tabId, wcId] of previewTabGuests()) {
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) continue;
    const pid = wc.getOSProcessId();
    if (!byPid.has(pid)) continue;
    tabs[tabId] = bytesByPid.get(pid) ?? 0;
  }
  let appBytes = 0;
  for (const bytes of bytesByPid.values()) appBytes += bytes;
  return { tabs, appBytes };
}

// Windows that "display" put in full screen. Leaving undoes only that, never
// a full screen the user chose for the window before.
const displayWindows = new Set<number>();

export function registerPreviewTabsIpc(handle: IpcHandle): void {
  handle("preview-bridge:tab-memory", async (): Promise<BrowserTabMemory> => readBrowserTabMemory());
  handle("preview-bridge:full-screen", async (event, request: BrowserFullScreenRequest): Promise<boolean> => {
    const mode = request?.mode;
    if (mode !== "off" && mode !== "window" && mode !== "display") return false;
    const tabId = typeof request.tabId === "string" ? request.tabId : null;
    for (const [id, wcId] of previewTabGuests()) {
      setGuestFullScreen(wcId, mode !== "off" && id === tabId);
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && mode === "display") {
      if (!win.isFullScreen()) {
        const id = win.id;
        displayWindows.add(id);
        win.once("leave-full-screen", () => displayWindows.delete(id));
        win.setFullScreen(true);
      }
    } else if (win && displayWindows.delete(win.id) && win.isFullScreen()) {
      win.setFullScreen(false);
    }
    return win?.isFullScreen() ?? false;
  });
}
