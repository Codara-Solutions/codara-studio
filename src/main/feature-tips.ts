import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { BrowserWindow } from "electron";
import {
  featureTipsMode,
  normalizeFeatureTipsState,
  withFeaturesUsed,
  withTipOutcome,
  withTipShown,
  withTipsEnabled,
  withTipsReset,
  type FeatureTipsBoot,
  type FeatureTipsState,
} from "@shared/feature-tips";
import { codaraHome } from "./codara-home";
import { writeFileAtomic } from "./fs-atomic";
import type { IpcHandle } from "./ipc";

// feature-tips.json in the Codara home: which features this person used and
// which tips they saw. It never leaves this computer.

export const FEATURE_TIPS_FILE = "feature-tips.json";

export interface FeatureTipsStore {
  load(): Promise<FeatureTipsState>;
  /** Applies a change and writes it; `changed` is false when nothing moved. */
  update(
    change: (state: FeatureTipsState) => FeatureTipsState,
  ): Promise<{ state: FeatureTipsState; changed: boolean }>;
}

export function createFeatureTipsStore(file: () => string): FeatureTipsStore {
  let cached: FeatureTipsState | null = null;
  // Every change reads the latest state and writes in turn, so two quick
  // records never overwrite each other.
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<FeatureTipsState> {
    if (cached) return cached;
    try {
      cached = normalizeFeatureTipsState(JSON.parse(await fs.readFile(file(), "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      cached = normalizeFeatureTipsState(null);
    }
    return cached;
  }

  return {
    load: () => {
      const result = queue.then(read);
      queue = result.catch(() => undefined);
      return result;
    },
    update: (change) => {
      const result = queue.then(async () => {
        const current = await read();
        const next = change(current);
        if (next === current) return { state: current, changed: false };
        await fs.mkdir(dirname(file()), { recursive: true });
        await writeFileAtomic(file(), JSON.stringify(next));
        cached = next;
        return { state: next, changed: true };
      });
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

const store = createFeatureTipsStore(() => join(codaraHome(), FEATURE_TIPS_FILE));

// App windows only: preview pages are webContents too, and what this person
// uses is none of their business.
function broadcast(state: FeatureTipsState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send("feature-tips:changed", state);
  }
}

async function change(update: (state: FeatureTipsState) => FeatureTipsState): Promise<FeatureTipsState> {
  const { state, changed } = await store.update(update);
  if (changed) broadcast(state);
  return state;
}

export function registerFeatureTipsIpc(handle: IpcHandle): void {
  handle("feature-tips:load", async (): Promise<FeatureTipsBoot> => ({
    state: await store.load(),
    ...featureTipsMode(process.env),
  }));
  handle("feature-tips:record-use", (_event, ids: unknown) =>
    change((state) => withFeaturesUsed(state, Array.isArray(ids) ? ids.slice(0, 64) : [], Date.now())),
  );
  handle("feature-tips:tip-shown", (_event, id: unknown) => change((state) => withTipShown(state, id, Date.now())));
  handle("feature-tips:tip-outcome", (_event, id: unknown, outcome: unknown) =>
    change((state) => withTipOutcome(state, id, outcome, Date.now())),
  );
  handle("feature-tips:set-enabled", (_event, enabled: unknown) => change((state) => withTipsEnabled(state, enabled)));
  handle("feature-tips:reset", () => change(withTipsReset));
}
