// Workspace sanitizer.
//
// Cora workers are instructed (via manager-profile.json's worker prompt
// opening) to keep their final diff focused: no `.tmp-*` scratch dirs, no
// planning markdowns, no compiler debris. In practice strong workers
// occasionally bypass that rule — typically by spawning a parallel `tsc`
// build into a temp outDir to run unit tests, or by leaving a planning
// scratchpad at the workspace root.
//
// This module provides the deterministic backstop. After the autopilot
// reaches a terminal status, the run-store calls `sanitizeWorkspace(cwd)`
// to delete the small set of patterns that are unambiguously scratch.
// The set is intentionally narrow — only names that have no legitimate
// purpose for any user (`.tmp-*` dirs, named scratch markdowns Codara or
// the eval harness add) — so the cleanup never destroys real work.
//
// Production runs and headless eval runs share this code path, so the
// hygiene the eval harness sees matches what an interactive user gets.

import { promises as fs } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_FILES = ["spark-eval-plan.md", "VARIANT-eval-plan.md"];
const FORBIDDEN_DIR_PREFIX = ".tmp-";

export interface SanitizeResult {
  removed: string[];
  errors: Array<{ path: string; error: string }>;
}

export async function sanitizeWorkspace(cwd: string): Promise<SanitizeResult> {
  const removed: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let entries: string[];
  try {
    entries = await fs.readdir(cwd);
  } catch {
    return { removed, errors };
  }
  for (const name of entries) {
    const isTmpDir = name.startsWith(FORBIDDEN_DIR_PREFIX);
    const isScratchFile = FORBIDDEN_FILES.includes(name);
    if (!isTmpDir && !isScratchFile) continue;
    const full = join(cwd, name);
    try {
      await fs.rm(full, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      errors.push({ path: full, error: (err as Error).message });
    }
  }
  return { removed, errors };
}
