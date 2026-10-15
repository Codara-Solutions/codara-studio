// Which repository setup commands the user approved, per repository, kept in
// Codara's own home and never in the repository. Anything that can write the
// repository (an agent, a pulled branch, a fresh clone) can change
// .codara/worktree.json, so a worktree nobody made by hand runs its commands
// only when this record holds those exact commands: the setup command and
// the commands of the file's terminals. The create dialog, which shows them,
// approves them; so does "Always allow" in the setup tray.
//
// Electron-free: index.ts hands the service a store on a file in the home,
// the unit suite one on a temp file.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { basename, dirname } from "node:path";
import { terminalsWithCommands, type WorktreeSetupTerminal } from "@shared/worktree-setup";
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
 * The fingerprint of a repository's setup commands: the setup command's
 * exact text, the shell that runs it (a bash script on macOS and Linux, one
 * cmd per line on Windows), and each terminal that runs a command, by name
 * and command. An approval never carries over to a different command, a
 * changed or added terminal, or the same text run another way. Null when the
 * file runs nothing.
 */
export function setupCommandFingerprint(
  command: string | null,
  platform: NodeJS.Platform | string,
  terminals: readonly WorktreeSetupTerminal[] = [],
): string | null {
  const running = terminalsWithCommands(terminals).map((terminal) => ({
    name: terminal.name,
    command: terminal.command ?? "",
  }));
  if (!command && !running.length) return null;
  const runner = platform === "win32" ? "win32-cmd-per-line" : "posix-bash-set-e";
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, runner, command: command ?? null, terminals: running }), "utf8")
    .digest("hex");
}

/** What an approval covers, as the record and the prompts show it. */
export function approvedCommandsText(command: string | null, terminals: readonly WorktreeSetupTerminal[] = []): string {
  return [
    ...(command ? [command] : []),
    ...terminalsWithCommands(terminals).map((terminal) => `terminal ${terminal.name}: ${terminal.command}`),
  ].join("\n");
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
