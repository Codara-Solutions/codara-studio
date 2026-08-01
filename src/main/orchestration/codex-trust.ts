// Codex workspace-trust pre-seeding, shared by the codex chat backend and
// worker spawns (run-store). Codex's interactive TUI prompts "Do you trust the
// contents of this directory?" for any cwd without a `[projects."<cwd>"]`
// trust block in ~/.codex/config.toml; under a headless pty nobody can answer
// and codex quits (exit 0), so the block must exist before spawn.
//
// The key must be the absolute path EXACTLY as codex sees it — case preserved,
// native separators. (A previous version lowercased and backslashed the path,
// which codex never matched, so every spawn in a fresh cwd hit the prompt.)

import { promises as fs } from "node:fs";

import { writeFileAtomic } from "../fs-atomic";
import { resolveCodexHomePaths } from "./codex-home";

// Process-local serialization for the ~/.codex/config.toml read-modify-write
// so two concurrent spawns for distinct cwds don't race the window and emit
// duplicate `[projects."X"]` blocks (duplicate TOML tables fail parsing on the
// next codex launch).
const codexConfigLocks = new Map<string, Promise<unknown>>();
// (configPath -> Set<cwd>) already verified this Codara session. First spawn
// in a cwd does the locked read-modify-write; later spawns short-circuit.
// Cleared on app restart, so a codex upgrade that invalidates the trust
// format is picked up next launch.
const codexTrustedCwds = new Map<string, Set<string>>();

export async function ensureCodexProjectTrust(
  cwd: string,
  codexHome?: string | null,
): Promise<void> {
  if (!cwd) return;
  const { configPath, homeDir } = resolveCodexHomePaths(codexHome);
  const cached = codexTrustedCwds.get(configPath);
  if (cached?.has(cwd)) return;
  const prior = codexConfigLocks.get(configPath) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(() => writeCodexProjectTrustEntry(homeDir, configPath, cwd));
  codexConfigLocks.set(configPath, next);
  try {
    await next;
    const set = codexTrustedCwds.get(configPath) ?? new Set<string>();
    set.add(cwd);
    codexTrustedCwds.set(configPath, set);
  } finally {
    if (codexConfigLocks.get(configPath) === next) {
      codexConfigLocks.delete(configPath);
    }
  }
}

// Codex itself writes basic (double-quoted) keys; earlier Codara versions
// wrote literal (single-quoted) ones. Either satisfies codex, but appending a
// second header for the same path would be a duplicate-table parse error, so
// the dedupe check must recognize both quotings.
function projectHeaderCandidates(cwd: string): string[] {
  return [`[projects."${escapeTomlBasic(cwd)}"]`, `[projects.'${cwd}']`];
}

function escapeTomlBasic(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function writeCodexProjectTrustEntry(
  codexHome: string,
  configPath: string,
  cwd: string,
): Promise<void> {
  const entry = `[projects."${escapeTomlBasic(cwd)}"]\ntrust_level = "trusted"\n`;
  let existing = "";
  let mode = 0o600;
  try {
    existing = await fs.readFile(configPath, "utf8");
    mode = await fs
      .stat(configPath)
      .then((stat) => stat.mode & 0o777)
      .catch(() => 0o600);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  }
  if (projectHeaderCandidates(cwd).some((header) => existing.includes(header))) {
    return;
  }
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  resolveCodexHomePaths(codexHome);
  await writeFileAtomic(configPath, `${existing}${sep}\n${entry}`, { mode });
}
