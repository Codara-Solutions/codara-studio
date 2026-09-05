import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import { runtimeFromProcessCommand } from "@shared/agent-patterns";
import { listProcessesWithCommands } from "./owned-process-tree";
import { resolveCodexTranscriptPath, resolveCodexHomePaths, pathIsInsideCodexHome } from "./orchestration/codex-home";
import { extractSessionUuid } from "./orchestration/codex-sessions";
import { latestSessionStart, recordSessionStart, type SessionStartRecord } from "./agent-session-registry";

interface ProcessEntry { pid: number; parentPid: number; command: string }
export interface CodexTrackedPane {
  paneId: string;
  pid: number;
  generationId: string;
  nativeCodexProfileId?: string;
}

// The outer CLI owns the pane. Its child agents must not replace its session.
export function codexProcessForPane(rootPid: number, processes: readonly ProcessEntry[]): number | null {
  let level = [rootPid];
  const seen = new Set<number>();
  while (level.length > 0) {
    const next: number[] = [];
    for (const pid of level) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const process = processes.find((entry) => entry.pid === pid);
      const runtime = process ? runtimeFromProcessCommand(process.command) : null;
      if (runtime === "codex") {
        // npm's launcher stays alive while the native child owns the rollout.
        // Only unwrap the official launcher, not an agent's arbitrary workers.
        const executable = process?.command.trim().split(/\s+/)[0].split(/[\\/]/).pop();
        const wrapped = process && /^(?:node|nodejs)(?:\.exe)?$/.test(executable ?? "") && /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js(?:["']|\s|$)/.test(process.command)
          ? processes.find((entry) => entry.parentPid === pid && runtimeFromProcessCommand(entry.command) === "codex")
          : undefined;
        if (wrapped) { next.push(wrapped.pid); continue; }
        return pid;
      }
      if (runtime) continue;
      next.push(...processes.filter((entry) => entry.parentPid === pid).map((entry) => entry.pid));
    }
    level = next;
  }
  return null;
}

export function parseCodexOpenFiles(output: string): Map<number, string[]> {
  const result = new Map<number, string[]>();
  let pid = 0;
  for (const field of output.split(/\r?\n/)) {
    if (/^p\d+$/.test(field)) pid = Number(field.slice(1));
    else if (pid && field.startsWith("n") && extractSessionUuid(field.slice(1))) {
      const paths = result.get(pid) ?? [];
      if (!paths.includes(field.slice(1))) paths.push(field.slice(1));
      result.set(pid, paths);
    }
  }
  return result;
}

async function openRollouts(pids: number[]): Promise<Map<number, string[]> | null> {
  if (pids.length === 0) return new Map();
  if (process.platform === "win32") return null;
  return new Promise((resolve) => {
    execFile(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      ["-nP", "-a", "-p", pids.join(","), "-Fpn"],
      { timeout: 1500, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? null : parseCodexOpenFiles(stdout)));
  });
}

export async function sessionFromOpenRollouts(paths: readonly string[], explicitHome?: string): Promise<{
  sessionId: string; transcriptPath: string; cwd: string;
} | null> {
  const candidates = await Promise.all(paths.map(async (path) => {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      // lsof supplies the actual file, including custom CODEX_HOME locations.
      // Validate the date-bucket shape and metadata before adopting its ID.
      if (!/[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]rollout-/.test(path)) return null;
      let home = path;
      for (let i = 0; i < 5; i++) home = dirname(home);
      resolveCodexTranscriptPath(path, home, { requireExisting: true });
      let transcriptPath = path;
      if (explicitHome) {
        const { sessionsRoot } = resolveCodexHomePaths(explicitHome);
        const realRoot = await fs.realpath(sessionsRoot);
        const realPath = await fs.realpath(path);
        if (!pathIsInsideCodexHome(realRoot, realPath)) return null;
        // macOS reports /private/var through lsof even when CODEX_HOME uses
        // /var. Persist the selected home's spelling for the resume probe.
        transcriptPath = resolveCodexTranscriptPath(join(sessionsRoot, relative(realRoot, realPath)), explicitHome);
      }
      handle = await fs.open(path, "r");
      const bytes = Buffer.alloc(16384);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const first = bytes.subarray(0, bytesRead).toString("utf8").split("\n")[0];
      const entry = JSON.parse(first);
      const meta = entry?.payload;
      const sessionId = extractSessionUuid(path);
      if (entry?.type !== "session_meta" || meta?.source !== "cli" ||
          typeof meta?.cwd !== "string" || !meta.cwd || !sessionId ||
          meta?.id?.toLowerCase() !== sessionId.toLowerCase()) return null;
      const stat = await handle.stat();
      return { sessionId, transcriptPath, cwd: meta.cwd as string, modified: stat.mtimeMs };
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }));
  // Codex can retain a previous conversation's descriptor after /resume.
  // Only files held by this process compete, never another pane's transcript.
  const found = candidates.filter((entry) => entry !== null).sort((a, b) => b.modified - a.modified)[0];
  if (!found) return null;
  return { sessionId: found.sessionId, transcriptPath: found.transcriptPath, cwd: found.cwd };
}

export function createCodexSessionTracker(deps: {
  panes: () => CodexTrackedPane[];
  codexHome?: () => string;
  processes?: () => Promise<readonly ProcessEntry[] | null>;
  files?: (pids: number[]) => Promise<Map<number, string[]> | null>;
  latest?: (paneId: string) => SessionStartRecord | null;
  record?: (record: SessionStartRecord) => void;
}) {
  const observed = new Map<string, CodexTrackedPane>();
  let pending: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let revision = 0;
  const latest = deps.latest ?? latestSessionStart;
  const record = deps.record ?? recordSessionStart;
  const refresh = (): Promise<void> => {
    if (pending) return pending;
    const startedRevision = revision;
    pending = (async () => {
      const panes = deps.panes();
      if (panes.length === 0 && observed.size === 0) return;
      const processes = await (deps.processes?.() ?? listProcessesWithCommands(2000));
      if (!processes) return;
      const live = panes.map((pane) => ({ pane, pid: codexProcessForPane(pane.pid, processes) }));
      const files = await (deps.files ?? openRollouts)([...new Set(live.flatMap(({ pid }) => pid ? [pid] : []))]);
      if (revision !== startedRevision) return;
      for (const { pane, pid } of live) {
        if (!pid || !files) continue;
        const session = await sessionFromOpenRollouts(files.get(pid) ?? [], deps.codexHome?.());
        if (revision !== startedRevision) return;
        if (!session || !deps.panes().some((now) => now.paneId === pane.paneId && now.generationId === pane.generationId)) continue;
        observed.set(pane.paneId, pane);
        const previous = latest(pane.paneId);
        if (previous?.runtime === "codex" && previous.sessionId === session.sessionId &&
            previous.transcriptPath === session.transcriptPath && previous.active === true && !previous.restoreOnBoot) continue;
        record({ ...session, paneId: pane.paneId, runtime: "codex", active: true,
          nativeCodexProfileId: pane.nativeCodexProfileId, source: "process",
          timestamp: new Date().toISOString() });
      }
      for (const paneId of observed.keys()) {
        if (live.some((entry) => entry.pane.paneId === paneId && entry.pid !== null)) continue;
        observed.delete(paneId);
        const previous = latest(paneId);
        if (previous?.runtime === "codex" && previous.active === true) {
          const { restoreOnBoot: _, ...persisted } = previous;
          record({ ...persisted, active: false, timestamp: new Date().toISOString() });
        }
      }
    })().catch(() => undefined).finally(() => { pending = null; });
    return pending;
  };
  return {
    refresh,
    start() { if (!timer) { timer = setInterval(() => { void refresh(); }, 3000); timer.unref(); } },
    stop() { if (timer) clearInterval(timer); timer = null; revision += 1; },
    async flush() {
      if (timer) clearInterval(timer);
      timer = null;
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([refresh(), new Promise<void>((resolve) => { deadline = setTimeout(resolve, 1000); })]);
      if (deadline) clearTimeout(deadline);
      // A slow process listing must not outlive the shutdown snapshot and
      // mark sessions inactive after shutdown kills their PTYs.
      revision += 1;
    },
  };
}
