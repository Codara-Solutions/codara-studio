// The names and pins a person gives agent sessions. They live in their own
// file in the Codara home, not in the index and not in the transcripts: the
// index is a cache that can be deleted, and the transcripts belong to the CLIs.
// No Electron here, so scripts/test-session-search.cjs can run it.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import {
  cleanSessionName,
  isSafeSessionId,
  isSessionSearchAgent,
  type SessionLabel,
  type SessionLabels,
} from "@shared/session-search";
import { writeFileAtomic } from "../fs-atomic";

/** `agent:id` with an id a CLI could have minted; nothing else is ever stored. */
export function isSessionLabelKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  const colon = key.indexOf(":");
  return colon > 0 && isSessionSearchAgent(key.slice(0, colon)) && isSafeSessionId(key.slice(colon + 1));
}

function normalizeLabels(raw: unknown): SessionLabels {
  const labels: SessionLabels = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return labels;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSessionLabelKey(key) || !value || typeof value !== "object") continue;
    const source = value as Record<string, unknown>;
    const name = cleanSessionName(source.name);
    const label: SessionLabel = {};
    if (name) label.name = name;
    if (source.pinned === true) label.pinned = true;
    if (label.name || label.pinned) labels[key] = label;
  }
  return labels;
}

export class SessionLabelStore {
  private labels: SessionLabels = {};
  private loading: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.path, "utf8");
    } catch {
      return;
    }
    try {
      this.labels = normalizeLabels(JSON.parse(text));
    } catch {
      // The next save would overwrite a file that may still be repairable by hand.
      await fs.rename(this.path, `${this.path}.corrupt`).catch(() => undefined);
    }
  }

  snapshot(): SessionLabels {
    return { ...this.labels };
  }

  nameOf(key: string): string | null {
    return this.labels[key]?.name ?? null;
  }

  /** Changes one session's label; a null name or a false pin removes that part. */
  update(key: string, patch: { name?: string | null; pinned?: boolean }): Promise<SessionLabel | null> {
    if (!isSessionLabelKey(key)) return Promise.reject(new Error("Not a session."));
    const change = this.writes.then(async () => {
      await this.load();
      const next: SessionLabel = { ...this.labels[key] };
      if (patch.name !== undefined) {
        const name = cleanSessionName(patch.name);
        if (name) next.name = name;
        else delete next.name;
      }
      if (patch.pinned !== undefined) {
        if (patch.pinned) next.pinned = true;
        else delete next.pinned;
      }
      const labels = { ...this.labels };
      if (next.name || next.pinned) labels[key] = next;
      else delete labels[key];
      await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.path, `${JSON.stringify(labels, null, 2)}\n`, { mode: 0o600 });
      this.labels = labels;
      return labels[key] ?? null;
    });
    // One failed save must not block the ones after it.
    this.writes = change.catch(() => undefined);
    return change;
  }
}
