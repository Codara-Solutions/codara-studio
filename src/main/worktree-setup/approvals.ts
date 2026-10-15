// Which repository setup commands the user approved, per repository, kept in
// Codara's own home and never in the repository. Anything that can write the
// repository (an agent, a pulled branch, a fresh clone) can change
// .codara/worktree.json, so a worktree nobody made by hand runs its command
// only when this record holds that exact command. The create dialog, which
// shows the command, approves it; so does "Always allow" in the setup tray.
//
// Electron-free: index.ts hands the service a store on a file in the home,
// the unit suite one on a temp file.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { basename, dirname } from "node:path";
import { writeFileAtomic } from "../fs-atomic";

export const SETUP_APPROVALS_FILE = "worktree-setup-approvals.json";

export interface SetupApprovalEntry {
  fingerprint: string;
  // The start of the command, so the file says what was approved.
  command: string;
  approvedAt: string;
}

export interface SetupApprovalStore {
  isApproved(repoKey: string, fingerprint: string): Promise<boolean>;
  approve(repoKey: string, entry: { fingerprint: string; repoName: string; command: string }): Promise<void>;
}

interface ApprovalFile {
  version: 1;
  repositories: Record<string, { name: string; commands: SetupApprovalEntry[] }>;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_COMMANDS_PER_REPO = 50;
const COMMAND_PREVIEW_CHARS = 500;

/**
 * The fingerprint of a repository setup command: the exact text and the
 * shell that runs it (a bash script on macOS and Linux, one cmd per line on
 * Windows), so an approval never carries over to a different command or to
 * the same text run another way.
 */
export function setupCommandFingerprint(command: string, platform: NodeJS.Platform | string): string {
  const runner = platform === "win32" ? "win32-cmd-per-line" : "posix-bash-set-e";
  return createHash("sha256").update(JSON.stringify({ version: 1, runner, command }), "utf8").digest("hex");
}

/**
 * The repository an approval belongs to: its common git folder, which every
 * checkout and worktree of it shares. Its name is the main checkout's folder.
 */
export function approvalRepository(commonGitDir: string, sourceRoot: string): { key: string; name: string } {
  const name = basename(commonGitDir) === ".git" ? basename(dirname(commonGitDir)) : basename(sourceRoot);
  return { key: commonGitDir, name: name || sourceRoot };
}

function emptyFile(): ApprovalFile {
  return { version: 1, repositories: {} };
}

function parse(text: string): ApprovalFile {
  try {
    const parsed = JSON.parse(text) as Partial<ApprovalFile> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.repositories !== "object" || !parsed.repositories) {
      return emptyFile();
    }
    const repositories: ApprovalFile["repositories"] = {};
    for (const [key, value] of Object.entries(parsed.repositories)) {
      if (!value || !Array.isArray(value.commands)) continue;
      repositories[key] = {
        name: typeof value.name === "string" ? value.name : "",
        commands: value.commands.filter(
          (entry): entry is SetupApprovalEntry =>
            !!entry && typeof entry.fingerprint === "string" && /^[0-9a-f]{64}$/.test(entry.fingerprint),
        ),
      };
    }
    return { version: 1, repositories };
  } catch {
    return emptyFile();
  }
}

/** A store on one JSON file. Writes are serialized; a missing or broken file reads as no approvals. */
export function fileApprovalStore(file: string): SetupApprovalStore {
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<ApprovalFile> => {
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return emptyFile();
    return parse(await fsp.readFile(file, "utf8").catch(() => ""));
  };
  return {
    async isApproved(repoKey, fingerprint) {
      await chain.catch(() => undefined);
      const data = await read();
      return data.repositories[repoKey]?.commands.some((entry) => entry.fingerprint === fingerprint) ?? false;
    },
    approve(repoKey, entry) {
      const write = async () => {
        const data = await read();
        const current = data.repositories[repoKey] ?? { name: entry.repoName, commands: [] };
        const commands = current.commands.filter((existing) => existing.fingerprint !== entry.fingerprint);
        commands.push({
          fingerprint: entry.fingerprint,
          command: entry.command.slice(0, COMMAND_PREVIEW_CHARS),
          approvedAt: new Date().toISOString(),
        });
        data.repositories[repoKey] = {
          name: entry.repoName || current.name,
          commands: commands.slice(-MAX_COMMANDS_PER_REPO),
        };
        await fsp.mkdir(dirname(file), { recursive: true });
        await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      };
      const next = chain.then(write, write);
      chain = next.catch(() => undefined);
      return next;
    },
  };
}
