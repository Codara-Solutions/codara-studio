// Shared Codex rollout/session discovery.
//
// Codex writes one JSONL "rollout" per session at
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// organized by DATE, not by cwd. These primitives (originally private to
// codex-backend.ts) let the managed chat backend find and identify a rollout
// after spawning `codex`.

import { promises as fs } from "node:fs";
import { join } from "node:path";

export const ROLLOUT_FILENAME_UUID_RE = /rollout-.*-([0-9a-f-]{36})\.jsonl$/i;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function sessionsDirFor(date: Date): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  return join(
    homeDir,
    ".codex",
    "sessions",
    String(date.getFullYear()),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  );
}

export function extractSessionUuid(rolloutPath: string): string | null {
  const match = rolloutPath.match(ROLLOUT_FILENAME_UUID_RE);
  return match ? match[1] : null;
}

// Candidate day-folders to scan for a rollout spawned around `spawnDate`: today,
// the spawn day, and the day before the spawn day. Codex names the file from the
// local time at run start, so a slow startup can leave it one folder back, and a
// midnight rollover during the spawn window is likewise covered.
function candidateDirs(spawnDate: Date, today: Date): Set<string> {
  const dirs = new Set<string>([sessionsDirFor(today), sessionsDirFor(spawnDate)]);
  const previous = new Date(spawnDate.getTime() - 24 * 60 * 60 * 1000);
  dirs.add(sessionsDirFor(previous));
  return dirs;
}

interface RolloutCandidate {
  path: string;
  mtimeMs: number;
}

// All rollout files across the candidate day-folders whose mtime is at or after
// `since`, sorted newest first.
async function listCandidates(
  since: number,
  spawnDate: Date,
  today: Date,
): Promise<RolloutCandidate[]> {
  const paths: string[] = [];
  for (const dir of candidateDirs(spawnDate, today)) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      paths.push(join(dir, name));
    }
  }
  const out: RolloutCandidate[] = [];
  for (const path of paths) {
    try {
      const stat = await fs.stat(path);
      if (stat.mtimeMs + 5 < since) continue; // 5ms slack for clock skew
      out.push({ path, mtimeMs: stat.mtimeMs });
    } catch {
      // vanished between readdir and stat — ignore
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Find the newest rollout-*.jsonl whose mtime is at or after `since`. This is
 * the mtime-only heuristic used by the managed chat backend, which spawns
 * codex serially and can assume the newest file is its own.
 */
export async function discoverRolloutPath(since: number, spawnDate: Date): Promise<string | null> {
  const candidates = await listCandidates(since, spawnDate, new Date());
  return candidates.length > 0 ? candidates[0].path : null;
}
