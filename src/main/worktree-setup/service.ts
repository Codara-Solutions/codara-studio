// Runs a worktree's setup: links and copies from the main checkout, then the
// repository's setup command and the user's own one, with a log the user can
// open and a status agents can wait on.
//
// Electron-free: the shell, the environment and change notifications come
// in as dependencies, so the unit suite runs real setups in temp folders.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, promises as fsp, renameSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  isWorktreeSetupFinished,
  repoSetupCommandFor,
  WORKTREE_INCLUDE_FILE,
  WORKTREE_SETUP_FILE,
  type WorktreeSetupCommand,
  type WorktreeSetupLogChunk,
  type WorktreeSetupState,
  type WorktreeSetupStatus,
  type WorktreeSetupTrigger,
} from "@shared/worktree-setup";
import {
  readSetupManifest,
  setupDirFor,
  SETUP_LOG_FILE,
  SETUP_MANIFEST_FILE,
  SETUP_STATUS_FILE,
} from "./links";
import { DEFAULT_COPY_BUDGET, manifestFrom, materializeSetup, type CopyBudget } from "./materialize";
import { copyPatterns, gitWithInput, readSetupSources, resolveCopyCandidates, resolveLinkSources } from "./plan";

export type UserShellKind = "posix" | "pwsh" | "cmd";

export interface UserShell {
  path: string;
  kind: UserShellKind;
}

export interface WorktreeSetupServiceDeps {
  platform?: NodeJS.Platform;
  // Environment for setup commands, before the CODARA_* variables are added.
  baseEnv(): Promise<Record<string, string>>;
  // The user's default shell, for their personal setup command.
  userShell(): Promise<UserShell | null>;
  onChange?(status: WorktreeSetupStatus): void;
  now?(): Date;
  commandTimeoutMs?: number;
  maxConcurrentCommands?: number;
  budget?: CopyBudget;
  logCapBytes?: number;
}

export interface StartSetupRequest {
  // A folder of the checkout the setup files are read and copied from.
  sourceCwd: string;
  worktreePath: string;
  trigger: WorktreeSetupTrigger;
  workspaceId?: string;
  workspaceName?: string;
  branch?: string;
  // False copies and links but leaves both commands out.
  runCommands?: boolean;
  // The per-user command (Settings, "Setup command for new worktrees").
  userCommand?: string | null;
}

export class WorktreeSetupError extends Error {}

const LIST_LIMIT = 200;
const TAIL_BYTES = 64 * 1024;
const DEFAULT_LOG_CAP = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const KILL_GRACE_MS = 3_000;
const INTERRUPTED = "Codara closed while setup was running";

interface Step {
  file: string;
  args: string[];
  verbatim?: boolean;
  shown: string;
}

interface Run {
  status: WorktreeSetupStatus;
  request: StartSetupRequest;
  worktreeReal: string;
  setupDir: string;
  logFile: string;
  log: WriteStream | null;
  logBytes: number;
  tail: string;
  child: ChildProcess | null;
  stopRequested: boolean;
  dismissed: boolean;
  prepared: Promise<WorktreeSetupStatus>;
  finished: Promise<WorktreeSetupStatus>;
  markPrepared(): void;
  markFinished(): void;
  releaseSlot: (() => void) | null;
}

export function setupIdFor(realWorktreePath: string): string {
  return createHash("sha256").update(realWorktreePath, "utf8").digest("hex").slice(0, 16);
}

function stamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

async function commonGitDir(cwd: string): Promise<string | null> {
  try {
    const out = (await gitWithInput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "")).trim();
    return out ? await fsp.realpath(out) : null;
  } catch {
    return null;
  }
}

function pwshQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class WorktreeSetupService {
  private readonly runs = new Map<string, Run>();
  private readonly platform: NodeJS.Platform;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly deps: WorktreeSetupServiceDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Starts setup for a worktree and returns its first status. Copies, links
   * and commands continue in the background; `whenPrepared` and `waitFor`
   * follow them. A setup already running for the worktree is returned as is.
   */
  async start(request: StartSetupRequest): Promise<WorktreeSetupStatus> {
    if (this.disposed) throw new WorktreeSetupError("Codara is closing");
    const worktreeReal = await fsp.realpath(request.worktreePath).catch(() => null);
    if (!worktreeReal) throw new WorktreeSetupError("The worktree folder does not exist");
    const id = setupIdFor(worktreeReal);
    const existing = this.runs.get(id);
    if (existing && !isWorktreeSetupFinished(existing.status.state)) return { ...existing.status };
    const setupDir = await setupDirFor(worktreeReal);
    if (!setupDir) throw new WorktreeSetupError("The folder is not a linked git worktree");
    const sources = await readSetupSources(request.sourceCwd);
    if (!sources) throw new WorktreeSetupError("The main checkout is not a git repository");
    if (sources.sourceRoot === worktreeReal) throw new WorktreeSetupError("The worktree is the main checkout");
    const [sourceCommon, worktreeCommon] = await Promise.all([
      commonGitDir(sources.sourceRoot),
      commonGitDir(worktreeReal),
    ]);
    if (!sourceCommon || sourceCommon !== worktreeCommon) {
      throw new WorktreeSetupError("The worktree does not belong to that repository");
    }

    const config = sources.file.config;
    const userCommand = request.userCommand?.trim() || null;
    const repoCommand = config ? repoSetupCommandFor(config, this.platform) : null;
    const runCommands = request.runCommands !== false;
    const commands: WorktreeSetupCommand[] = [];
    if (repoCommand) {
      commands.push({ kind: "repo", label: `Setup command from ${WORKTREE_SETUP_FILE}`, command: repoCommand, state: "pending" });
    }
    if (userCommand) {
      commands.push({ kind: "user", label: "Your setup command for this repository", command: userCommand, state: "pending" });
    }
    if (!runCommands) for (const command of commands) command.state = "skipped";

    const warnings = [
      ...sources.include.errors,
      ...sources.file.warnings,
      ...(config ? sources.file.errors : []),
    ];
    const status: WorktreeSetupStatus = {
      id,
      worktreePath: worktreeReal,
      sourcePath: sources.sourceRoot,
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(request.branch ? { branch: request.branch } : {}),
      trigger: request.trigger,
      state: "preparing",
      startedAt: this.now().toISOString(),
      sources: {
        worktreeInclude: sources.include.present,
        setupFile: sources.file.present,
        userCommand: Boolean(userCommand),
      },
      copied: [],
      copiedCount: 0,
      linked: [],
      skipped: [],
      warnings,
      commands,
      ...(!runCommands && commands.length ? { commandsSkipped: true } : {}),
      waitForSetup: config?.waitForSetup ?? false,
      terminals: config?.terminals ?? [],
      logPath: join(setupDir, SETUP_LOG_FILE),
    };

    let markPrepared = () => undefined as void;
    let markFinished = () => undefined as void;
    const run: Run = {
      status,
      request: { ...request, userCommand },
      worktreeReal,
      setupDir,
      logFile: status.logPath,
      log: null,
      logBytes: 0,
      tail: "",
      child: null,
      stopRequested: false,
      dismissed: false,
      prepared: Promise.resolve(status),
      finished: Promise.resolve(status),
      markPrepared: () => markPrepared(),
      markFinished: () => markFinished(),
      releaseSlot: null,
    };
    run.prepared = new Promise((resolvePromise) => {
      markPrepared = () => resolvePromise({ ...run.status });
    });
    run.finished = new Promise((resolvePromise) => {
      markFinished = () => resolvePromise({ ...run.status });
    });
    this.runs.set(id, run);

    await fsp.mkdir(setupDir, { recursive: true });
    run.log = createWriteStream(run.logFile, { flags: "w" });
    run.log.on("error", () => {
      run.log = null;
    });
    this.writeLog(run, `Worktree setup, ${stamp(this.now())}\n`);
    this.writeLog(run, `Worktree: ${worktreeReal}\nMain checkout: ${sources.sourceRoot}\n`);
    const used = [
      sources.include.present ? WORKTREE_INCLUDE_FILE : "",
      sources.file.present ? WORKTREE_SETUP_FILE : "",
      userCommand ? "your setup command" : "",
    ].filter(Boolean);
    this.writeLog(run, used.length ? `Using ${used.join(", ")}\n` : "Nothing to set up\n");
    for (const warning of warnings) this.writeLog(run, `Warning: ${warning}\n`);
    this.persist(run);

    void this.pipeline(run, sources).catch((err: unknown) => {
      this.finish(run, "failed", `Setup could not run: ${(err as Error)?.message ?? String(err)}`);
    });
    return { ...status };
  }

  /** Resolves once copies and links are done (or setup ended first). */
  async whenPrepared(id: string): Promise<WorktreeSetupStatus | null> {
    const run = this.runs.get(id);
    if (!run) return this.get(id);
    return run.prepared;
  }

  /** Resolves when setup ends, or with the current status after `timeoutMs`. */
  async waitFor(id: string, timeoutMs: number): Promise<WorktreeSetupStatus | null> {
    const run = this.runs.get(id);
    if (!run) return this.get(id);
    if (isWorktreeSetupFinished(run.status.state)) return { ...run.status };
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<WorktreeSetupStatus>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise({ ...run.status }), Math.max(0, timeoutMs));
    });
    try {
      return await Promise.race([run.finished, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A status by id (this session) or by worktree path (also earlier sessions). */
  async get(idOrPath: string): Promise<WorktreeSetupStatus | null> {
    const inMemory = this.runs.get(idOrPath);
    if (inMemory) return { ...inMemory.status };
    if (!/[\\/]/.test(idOrPath)) return null;
    const real = await fsp.realpath(idOrPath).catch(() => null);
    if (!real) return null;
    const run = this.runs.get(setupIdFor(real));
    if (run) return { ...run.status };
    return this.readStoredStatus(real);
  }

  /** Setups of this session the user has not dismissed, newest first. */
  list(): WorktreeSetupStatus[] {
    return [...this.runs.values()]
      .filter((run) => !run.dismissed)
      .map((run) => ({ ...run.status }))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  dismiss(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || !isWorktreeSetupFinished(run.status.state)) return false;
    run.dismissed = true;
    return true;
  }

  async stop(id: string): Promise<WorktreeSetupStatus | null> {
    const run = this.runs.get(id);
    if (!run) return this.get(id);
    if (isWorktreeSetupFinished(run.status.state)) return { ...run.status };
    run.stopRequested = true;
    this.writeLog(run, "\nStopped by the user\n");
    if (run.child) this.killTree(run.child);
    else if (run.status.state === "queued" || run.status.state === "preparing") {
      this.finish(run, "stopped", "Stopped");
    }
    return this.waitFor(id, KILL_GRACE_MS * 2 + 1_000);
  }

  /** Runs setup again for a worktree whose setup ended. */
  async rerun(idOrPath: string, overrides: Partial<StartSetupRequest> = {}): Promise<WorktreeSetupStatus> {
    const run = this.runs.get(idOrPath);
    let request: StartSetupRequest | null = run ? run.request : null;
    if (run && !isWorktreeSetupFinished(run.status.state)) return { ...run.status };
    if (!request) {
      const status = await this.get(idOrPath);
      if (!status) throw new WorktreeSetupError("No setup is known for that worktree");
      request = {
        sourceCwd: status.sourcePath,
        worktreePath: status.worktreePath,
        trigger: status.trigger,
        ...(status.workspaceId ? { workspaceId: status.workspaceId } : {}),
        ...(status.branch ? { branch: status.branch } : {}),
        userCommand: status.commands.find((command) => command.kind === "user")?.command ?? null,
      };
    }
    if (run) this.runs.delete(run.status.id);
    return this.start({ ...request, runCommands: true, ...overrides });
  }

  async readLog(id: string, from = 0, maxBytes = 256 * 1024): Promise<WorktreeSetupLogChunk | null> {
    const status = await this.get(id);
    if (!status) return null;
    const setupDir = await setupDirFor(status.worktreePath);
    if (!setupDir) return null;
    const file = join(setupDir, SETUP_LOG_FILE);
    const handle = await fsp.open(file, "r").catch(() => null);
    if (!handle) return { text: "", next: 0, size: 0, truncated: false };
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, Math.min(from, size));
      const length = Math.min(maxBytes, size - start);
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, start);
      // Never cut a character in half: stop before a partial UTF-8 sequence.
      let end = length;
      if (start + length < size) {
        let back = 0;
        while (back < 4 && end - back - 1 >= 0 && (buffer[end - back - 1] & 0xc0) === 0x80) back += 1;
        if (end - back - 1 >= 0 && buffer[end - back - 1] >= 0xc0) end = end - back - 1;
      }
      return {
        text: buffer.subarray(0, end).toString("utf8"),
        next: start + end,
        size,
        truncated: start + end < size,
      };
    } finally {
      await handle.close();
    }
  }

  /** The last `lines` lines of a setup's log. */
  async tail(id: string, lines = 40): Promise<string> {
    const run = this.runs.get(id);
    let text = run?.tail ?? "";
    if (!run) {
      const status = await this.get(id);
      if (!status) return "";
      const setupDir = await setupDirFor(status.worktreePath);
      if (!setupDir) return "";
      const handle = await fsp.open(join(setupDir, SETUP_LOG_FILE), "r").catch(() => null);
      if (!handle) return "";
      try {
        const { size } = await handle.stat();
        const length = Math.min(TAIL_BYTES, size);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        text = buffer.toString("utf8");
      } finally {
        await handle.close();
      }
    }
    const all = text.replace(/\r\n/g, "\n").split("\n");
    if (all[all.length - 1] === "") all.pop();
    return all.slice(-Math.max(1, Math.min(lines, 500))).join("\n");
  }

  /** Stops every running setup; for app shutdown. Synchronous on purpose. */
  dispose(): void {
    this.disposed = true;
    for (const run of this.runs.values()) {
      if (isWorktreeSetupFinished(run.status.state)) continue;
      run.stopRequested = true;
      if (run.child) this.killTree(run.child, true);
      this.applyFinish(run, "stopped", INTERRUPTED);
      this.persistSync(run);
      run.log?.end();
      run.markPrepared();
      run.markFinished();
    }
  }

  // ── Pipeline ─────────────────────────────────────────────────────────────

  private async pipeline(run: Run, sources: NonNullable<Awaited<ReturnType<typeof readSetupSources>>>): Promise<void> {
    const root = sources.sourceRoot;
    const config = sources.file.config;
    const patterns = copyPatterns(sources);
    const resolved = patterns.length
      ? await resolveCopyCandidates(root, patterns)
      : { candidates: [], notices: [] as string[] };
    const linkSources = config?.link.length
      ? await resolveLinkSources(root, config.link)
      : { links: [] as string[], skipped: [] };
    for (const notice of resolved.notices) {
      run.status.warnings.push(notice);
      this.writeLog(run, `Warning: ${notice}\n`);
    }
    const outcome = await materializeSetup({
      sourceRoot: root,
      worktreeRoot: run.worktreeReal,
      copies: resolved.candidates,
      links: linkSources.links,
      budget: this.deps.budget ?? DEFAULT_COPY_BUDGET,
      platform: this.platform,
      log: (line) => this.writeLog(run, `${line}\n`),
      stopped: () => run.stopRequested,
    });
    const previous = await readSetupManifest(run.worktreeReal).catch(() => null);
    const manifest = manifestFrom(root, previous, outcome);
    await this.writeJson(join(run.setupDir, SETUP_MANIFEST_FILE), manifest);

    const skipped = [...linkSources.skipped, ...outcome.skipped];
    for (const skip of linkSources.skipped) this.writeLog(run, `Skipped ${skip.path}: ${skip.reason}\n`);
    run.status.copied = outcome.copied.slice(0, LIST_LIMIT);
    run.status.copiedCount = outcome.copiedFiles.length;
    run.status.linked = outcome.linked.map((link) => link.path);
    run.status.skipped = skipped.slice(0, LIST_LIMIT);
    run.status.warnings.push(...outcome.warnings);
    for (const warning of outcome.warnings) this.writeLog(run, `Warning: ${warning}\n`);

    if (run.stopRequested) {
      this.finish(run, "stopped", "Stopped");
      return;
    }
    // A setup file Codara cannot read at all is a failure the user has to
    // see, after whatever .worktreeinclude could still copy.
    if (sources.file.present && !config) {
      this.finish(run, "failed", sources.file.errors[0] ?? `${WORKTREE_SETUP_FILE} could not be read`);
      return;
    }
    const pending = run.status.commands.filter((command) => command.state === "pending");
    if (!pending.length) {
      this.finish(run, "succeeded");
      return;
    }
    this.change(run, "queued");
    run.markPrepared();
    await this.acquireSlot(run);
    if (run.stopRequested || isWorktreeSetupFinished(run.status.state)) {
      run.releaseSlot?.();
      if (!isWorktreeSetupFinished(run.status.state)) this.finish(run, "stopped", "Stopped");
      return;
    }
    this.change(run, "running");
    try {
      const env = await this.commandEnv(run);
      for (const command of run.status.commands) {
        if (command.state !== "pending") continue;
        if (run.stopRequested) {
          command.state = "stopped";
          continue;
        }
        command.state = "running";
        this.persist(run);
        this.emit(run);
        const exit = await this.runCommand(run, command, env);
        command.exitCode = exit.code;
        if (run.stopRequested) {
          command.state = "stopped";
          for (const rest of run.status.commands) if (rest.state === "pending") rest.state = "skipped";
          this.finish(run, "stopped", "Stopped");
          return;
        }
        if (exit.code !== 0) {
          command.state = "failed";
          for (const rest of run.status.commands) if (rest.state === "pending") rest.state = "skipped";
          run.status.exitCode = exit.code;
          const what = command.kind === "repo" ? "The setup command" : "Your setup command";
          this.finish(run, "failed", exit.timedOut ? `${what} ran for too long and was stopped` : `${what} exited with code ${exit.code ?? "unknown"}`);
          return;
        }
        command.state = "succeeded";
      }
      run.status.exitCode = 0;
      this.finish(run, "succeeded");
    } finally {
      run.releaseSlot?.();
      run.releaseSlot = null;
    }
  }

  private async commandEnv(run: Run): Promise<Record<string, string>> {
    const env = await this.deps.baseEnv();
    env.CODARA_ROOT_PATH = run.status.sourcePath;
    env.CODARA_WORKTREE_PATH = run.worktreeReal;
    if (run.status.branch) env.CODARA_WORKTREE_BRANCH = run.status.branch;
    if (run.request.workspaceName) env.CODARA_WORKSPACE_NAME = run.request.workspaceName;
    return env;
  }

  private async acquireSlot(run: Run): Promise<void> {
    const max = Math.max(1, this.deps.maxConcurrentCommands ?? 2);
    if (this.active >= max) {
      this.writeLog(run, "Waiting for other worktree setups to finish\n");
      await new Promise<void>((resolvePromise) => this.waiting.push(resolvePromise));
    }
    this.active += 1;
    let released = false;
    run.releaseSlot = () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }

  private async stepsFor(run: Run, command: WorktreeSetupCommand): Promise<Step[]> {
    const lines = command.command.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    const comspec = process.env.ComSpec || "cmd.exe";
    const cmdLine = (line: string): Step => ({
      file: comspec,
      args: ["/d", "/s", "/c", `"${line}"`],
      verbatim: true,
      shown: line,
    });
    if (command.kind === "repo") {
      if (this.platform === "win32") return lines.map(cmdLine);
      const script = join(run.setupDir, "repo-setup.sh");
      await fsp.writeFile(script, `set -e\n${command.command}\n`, { mode: 0o600 });
      return [{ file: posixRunner(), args: [script], shown: command.command }];
    }
    const shell = await this.deps.userShell().catch(() => null);
    if (shell?.kind === "pwsh") {
      const script = join(run.setupDir, "user-setup.ps1");
      await fsp.writeFile(
        script,
        `Set-Location -LiteralPath ${pwshQuote(run.worktreeReal)}\r\n${command.command.replace(/\n/g, "\r\n")}\r\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\r\n`,
        { mode: 0o600 },
      );
      return [
        {
          file: shell.path,
          args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
          shown: command.command,
        },
      ];
    }
    if (this.platform === "win32") {
      return lines.map((line) => (shell?.kind === "cmd" ? { ...cmdLine(line), file: shell.path } : cmdLine(line)));
    }
    const script = join(run.setupDir, "user-setup.sh");
    await fsp.writeFile(script, `${command.command}\n`, { mode: 0o600 });
    return [{ file: shell?.kind === "posix" ? shell.path : posixRunner(), args: [script], shown: command.command }];
  }

  private async runCommand(
    run: Run,
    command: WorktreeSetupCommand,
    env: Record<string, string>,
  ): Promise<{ code: number | null; timedOut: boolean }> {
    const steps = await this.stepsFor(run, command);
    const deadline = Date.now() + (this.deps.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.writeLog(run, `\n${command.label}\n`);
    for (const step of steps) {
      if (run.stopRequested) return { code: null, timedOut: false };
      this.writeLog(run, `${step.shown.split("\n").map((line) => `$ ${line}`).join("\n")}\n`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { code: null, timedOut: true };
      const result = await this.runStep(run, step, env, remaining);
      if (result.timedOut) {
        this.writeLog(run, "Stopped: it ran for too long\n");
        return result;
      }
      if (result.code !== 0) {
        this.writeLog(run, `Exited with code ${result.code ?? "unknown"}\n`);
        return result;
      }
    }
    this.writeLog(run, "Done\n");
    return { code: 0, timedOut: false };
  }

  private runStep(
    run: Run,
    step: Step,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ code: number | null; timedOut: boolean }> {
    return new Promise((resolvePromise) => {
      let child: ChildProcess;
      try {
        child = spawn(step.file, step.args, {
          cwd: run.worktreeReal,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: this.platform !== "win32",
          ...(step.verbatim ? { windowsVerbatimArguments: true } : {}),
        });
      } catch (err) {
        this.writeLog(run, `Could not start: ${(err as Error).message}\n`);
        resolvePromise({ code: 127, timedOut: false });
        return;
      }
      run.child = child;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.killTree(child);
      }, timeoutMs);
      const pipe = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) return;
        const decoder = new StringDecoder("utf8");
        stream.on("data", (chunk: Buffer) => this.writeLog(run, decoder.write(chunk)));
        stream.on("end", () => {
          const rest = decoder.end();
          if (rest) this.writeLog(run, rest);
        });
      };
      pipe(child.stdout);
      pipe(child.stderr);
      let settled = false;
      const settle = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.child = null;
        resolvePromise({ code, timedOut });
      };
      child.on("error", (err) => {
        this.writeLog(run, `Could not start: ${err.message}\n`);
        settle(127);
      });
      child.on("close", (code, signal) => settle(code ?? (signal ? 128 + (signalNumber(signal) ?? 15) : null)));
    });
  }

  private killTree(child: ChildProcess, immediate = false): void {
    const pid = child.pid;
    if (!pid) return;
    if (this.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
      } catch {
        child.kill();
      }
      return;
    }
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    if (immediate) {
      signalGroup("SIGKILL");
      return;
    }
    signalGroup("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalGroup("SIGKILL");
    }, KILL_GRACE_MS).unref();
  }

  // ── Status and log ───────────────────────────────────────────────────────

  private change(run: Run, state: WorktreeSetupState): void {
    run.status.state = state;
    this.persist(run);
    this.emit(run);
  }

  private applyFinish(run: Run, state: WorktreeSetupState, error?: string): void {
    run.status.state = state;
    run.status.finishedAt = this.now().toISOString();
    if (error) run.status.error = error;
    else delete run.status.error;
    for (const command of run.status.commands) {
      if (command.state === "running") command.state = state === "succeeded" ? "succeeded" : "stopped";
      if (command.state === "pending") command.state = "skipped";
    }
  }

  private finish(run: Run, state: WorktreeSetupState, error?: string): void {
    if (isWorktreeSetupFinished(run.status.state)) return;
    this.applyFinish(run, state, error);
    const word = state === "succeeded" ? "Setup finished" : state === "stopped" ? "Setup stopped" : "Setup failed";
    this.writeLog(run, `\n${word}${error ? `: ${error}` : ""}, ${stamp(this.now())}\n`);
    this.persist(run);
    run.log?.end();
    run.log = null;
    this.emit(run);
    run.markPrepared();
    run.markFinished();
  }

  private emit(run: Run): void {
    try {
      this.deps.onChange?.({ ...run.status });
    } catch {
      /* a listener must never break setup */
    }
  }

  private writeLog(run: Run, text: string): void {
    if (!text) return;
    run.tail = (run.tail + text).slice(-TAIL_BYTES);
    if (!run.log) return;
    const cap = this.deps.logCapBytes ?? DEFAULT_LOG_CAP;
    const bytes = Buffer.byteLength(text);
    if (run.logBytes >= cap) return;
    if (run.logBytes + bytes > cap) {
      run.log.write(Buffer.from(text).subarray(0, cap - run.logBytes));
      run.log.write("\n[The log reached its size limit; later output is not saved]\n");
      run.logBytes = cap;
      return;
    }
    run.log.write(text);
    run.logBytes += bytes;
  }

  private statusFile(run: Run): string {
    return join(run.setupDir, SETUP_STATUS_FILE);
  }

  private persist(run: Run): void {
    void this.writeJson(this.statusFile(run), run.status).catch(() => undefined);
  }

  private persistSync(run: Run): void {
    try {
      const file = this.statusFile(run);
      writeFileSync(`${file}.tmp`, JSON.stringify(run.status, null, 2));
      renameSync(`${file}.tmp`, file);
    } catch {
      /* the worktree may be gone */
    }
  }

  private writeChain: Promise<void> = Promise.resolve();

  private writeJson(file: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value, null, 2);
    const write = async () => {
      if (!existsSync(join(file, ".."))) return;
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, file);
    };
    this.writeChain = this.writeChain.then(write, write);
    return this.writeChain;
  }

  private async readStoredStatus(worktreeReal: string): Promise<WorktreeSetupStatus | null> {
    const setupDir = await setupDirFor(worktreeReal);
    if (!setupDir) return null;
    const file = join(setupDir, SETUP_STATUS_FILE);
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > 4 * 1024 * 1024) return null;
    let status: WorktreeSetupStatus;
    try {
      status = JSON.parse(await fsp.readFile(file, "utf8")) as WorktreeSetupStatus;
    } catch {
      return null;
    }
    if (!status || typeof status !== "object" || typeof status.state !== "string") return null;
    // Only fields this module wrote are trusted; the paths are this worktree's.
    status.id = setupIdFor(worktreeReal);
    status.worktreePath = worktreeReal;
    status.logPath = join(setupDir, SETUP_LOG_FILE);
    if (!isWorktreeSetupFinished(status.state)) {
      status.state = "stopped";
      status.error = INTERRUPTED;
      status.finishedAt ??= status.startedAt;
      for (const command of status.commands ?? []) {
        if (command.state === "running") command.state = "stopped";
        if (command.state === "pending") command.state = "skipped";
      }
      await this.writeJson(file, status).catch(() => undefined);
    }
    return status;
  }
}

function posixRunner(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "/bin/sh";
}

function signalNumber(signal: NodeJS.Signals): number | null {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return table[signal] ?? null;
}

/** The short summary agents get for a setup. */
export function agentSetupSummary(status: WorktreeSetupStatus, logTail: string): Record<string, unknown> {
  const hint =
    status.state === "failed"
      ? "Setup failed. Read logTail, fix the cause, and run it again from Codara or by hand in the worktree."
      : status.state === "stopped"
        ? "Setup was stopped before it finished; the worktree may be missing dependencies."
        : status.state === "succeeded"
          ? "Setup finished."
          : "Setup is still running. Call codara_worktree_setup({wait: true}) before you build or test.";
  return {
    state: status.state,
    waitForSetup: status.waitForSetup,
    copied: status.copiedCount,
    linked: status.linked,
    ...(status.skipped.length ? { skipped: status.skipped.slice(0, 20) } : {}),
    ...(status.warnings.length ? { warnings: status.warnings.slice(0, 20) } : {}),
    commands: status.commands.map((command) => ({
      kind: command.kind,
      command: command.command.length > 400 ? `${command.command.slice(0, 400)}...` : command.command,
      state: command.state,
      ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
    })),
    ...(status.commandsSkipped ? { commandsSkipped: true } : {}),
    ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
    ...(status.error ? { error: status.error } : {}),
    ...(status.terminals.length ? { terminals: status.terminals } : {}),
    startedAt: status.startedAt,
    ...(status.finishedAt ? { finishedAt: status.finishedAt } : {}),
    logPath: status.logPath,
    ...(logTail ? { logTail } : {}),
    hint,
  };
}
