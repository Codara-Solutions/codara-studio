// The dev-server keeper. A server Codara starts runs in a terminal session
// that main owns, not in any agent's pane or process tree and not tied to a
// Cora run, so it keeps running when the agent that asked for it exits,
// restarts or finishes its turn; only stop, forget or quitting Codara ends
// it. Every agent and the user reach it by workspace and id. All effects
// come in through KeeperDeps, so scripts/test-servers.cjs drives the real
// logic with fakes.

import type {
  DevServerLogs,
  DevServerSaveInput,
  DevServerSpec,
  DevServerStartInput,
  DevServerState,
  DevServerStatus,
} from "@shared/servers";
import {
  checkCommand,
  checkEnv,
  checkPort,
  checkUrl,
  completeLines,
  findLocalUrls,
  plainTerminalText,
  portOfUrl,
  SERVER_ID_RE,
  ServerInputError,
  serverSlug,
  splitEnvPrefix,
  suggestServerId,
} from "./detect";
import type { PortOwner } from "./health";
import type { ServerStore } from "./store";

export { ServerInputError } from "./detect";

/** A start that would make a second copy or collide with another process. */
export class ServerConflictError extends Error {}

export interface KeeperDeps {
  store: ServerStore;
  /** Starts the command in a new terminal session that main owns. */
  spawn(input: { paneId: string; cwd: string; command: string; env: Record<string, string> }): Promise<void>;
  kill(paneId: string): void;
  exists(paneId: string): boolean;
  onOutput(paneId: string, listener: (chunk: string) => void): () => void;
  onExit(paneId: string, listener: (exitCode: number | null) => void): () => void;
  portAnswers(port: number): Promise<boolean>;
  portOwner(port: number): Promise<PortOwner | null>;
  /** The Codara terminal pane a process runs in, if any. */
  paneOfPid(pid: number): Promise<string | null>;
  isDirectory(path: string): Promise<boolean>;
  /** Local workspace folder; null for an unknown or remote workspace. */
  workspaceCwd(workspaceId: string): Promise<string | null>;
  writeLog(workspaceId: string, id: string, text: string): Promise<string>;
  /** Stops a server the keeper learned in a pane: its process when known, else the pane's foreground command. */
  stopPane(paneId: string, pid: number | null): Promise<void>;
  changed(workspaceId: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  env: Readonly<Record<string, string | undefined>>;
}

const LOG_KEEP_CHARS = 200_000;
const LOG_REPLY_CHARS = 4_000;
const READY_WAIT_MS = 15_000;
const STOP_WAIT_MS = 3_000;

interface Live {
  workspaceId: string;
  id: string;
  paneId: string;
  owned: boolean;
  /** The listening process of a server learned in a pane, when known. */
  pid: number | null;
  state: Exclude<DevServerState, "stopped">;
  startedAt: number;
  exitCode: number | null;
  log: string;
  /** Characters dropped from the front of `log`; a cursor is an absolute offset. */
  dropped: number;
  env: Record<string, string>;
  detach: () => void;
}

/** A server seen running in a terminal pane. */
export interface LearnInput {
  workspaceId: string;
  paneId: string;
  command: string;
  cwd: string;
  url: string;
  port: number;
  pid?: number | null;
  source: "agent" | "user";
}

export interface StartResult {
  server: DevServerStatus;
  alreadyRunning: boolean;
  /** The URL appeared or the port answered within the wait. */
  ready: boolean;
  /** The last output, when the process ended during the wait. */
  output?: string;
}

function key(workspaceId: string, id: string): string {
  return `${workspaceId}\u0000${id}`;
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string): string => value.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * A fresh session id per start: the exit of a killed earlier process must
 * never be read as the end of the one replacing it.
 */
export function serverPaneId(workspaceId: string, id: string, startedAt: number): string {
  return `server-${serverSlug(workspaceId).slice(0, 24) || "ws"}-${id}-${startedAt.toString(36)}`;
}

export function createServerKeeper(deps: KeeperDeps) {
  const live = new Map<string, Live>();
  /** Env values of this app session, by server; never written anywhere. */
  const envValues = new Map<string, Record<string, string>>();
  const autoStarted = new Set<string>();
  const queues = new Map<string, Promise<unknown>>();

  /**
   * Starts, stops and saves of one workspace run one at a time: two callers
   * (an agent and the status view, or two agents) must never both pass the
   * copy and port checks before either has spawned. The wait for ready runs
   * outside, so a slow server does not hold the others up.
   */
  function serial<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(workspaceId) ?? Promise.resolve()).catch(() => undefined).then(task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(workspaceId, settled);
    void settled.then(() => {
      if (queues.get(workspaceId) === settled) queues.delete(workspaceId);
    });
    return run;
  }

  async function resolveCwd(workspaceId: string, raw: unknown, fallback?: string): Promise<string> {
    const root = await deps.workspaceCwd(workspaceId);
    if (!root) throw new ServerInputError("This workspace is not a local folder, so Codara cannot run its servers.");
    let cwd = typeof raw === "string" && raw.trim() ? raw.trim() : fallback ?? root;
    if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(cwd)) cwd = `${root.replace(/[\\/]+$/, "")}/${cwd}`;
    if (!(await deps.isDirectory(cwd))) throw new ServerInputError(`cwd is not a folder: ${cwd}`);
    return cwd;
  }

  function liveOf(workspaceId: string, id: string): Live | null {
    const entry = live.get(key(workspaceId, id)) ?? null;
    if (entry && entry.owned && entry.state === "running" && !deps.exists(entry.paneId)) {
      entry.state = "exited";
    }
    return entry;
  }

  function isRunning(entry: Live | null): boolean {
    return !!entry && (entry.state === "running" || entry.state === "pane");
  }

  async function paneServerUp(entry: Live, spec: DevServerSpec | null): Promise<boolean> {
    if (!deps.exists(entry.paneId)) return false;
    const port = spec ? spec.port ?? portOfUrl(spec.url) : null;
    return port ? deps.portAnswers(port).catch(() => false) : true;
  }

  async function statusOf(workspaceId: string, spec: DevServerSpec, probe = true): Promise<DevServerStatus> {
    const entry = liveOf(workspaceId, spec.id);
    const port = spec.port ?? portOfUrl(spec.url);
    const answers = probe && port ? await deps.portAnswers(port).catch(() => false) : null;
    let state: DevServerState = entry ? entry.state : "stopped";
    // A learned server ends when its pane's command does, with the pane still open.
    if (state === "pane" && entry && (!deps.exists(entry.paneId) || answers === false)) state = "stopped";
    const values = envValues.get(key(workspaceId, spec.id)) ?? {};
    // Something else answering on a stopped server's port is the conflict a
    // start would refuse with, so it is reported before anyone tries.
    const conflict =
      answers === true && port && state !== "running" && state !== "pane"
        ? await describePortHolder(workspaceId, port, spec.id)
        : null;
    return {
      ...spec,
      workspaceId,
      state,
      health: answers === null ? "unknown" : answers ? "up" : "down",
      paneId: entry && state !== "stopped" ? entry.paneId : null,
      startedAt: entry && state !== "stopped" ? entry.startedAt : null,
      exitCode: entry && state === "exited" ? entry.exitCode : null,
      missingEnv: spec.envNames.filter((name) => values[name] === undefined && deps.env[name] === undefined),
      conflict,
    };
  }

  async function list(workspaceId: string, options: { probe?: boolean } = {}): Promise<DevServerStatus[]> {
    const specs = await deps.store.list(workspaceId);
    return Promise.all(specs.map((spec) => statusOf(workspaceId, spec, options.probe !== false)));
  }

  async function findSpec(workspaceId: string, id: string): Promise<DevServerSpec | null> {
    return (await deps.store.list(workspaceId)).find((spec) => spec.id === id) ?? null;
  }

  function appendLog(entry: Live, chunk: string): void {
    entry.log += chunk;
    if (entry.log.length > LOG_KEEP_CHARS) {
      const cut = entry.log.length - LOG_KEEP_CHARS;
      entry.log = entry.log.slice(cut);
      entry.dropped += cut;
    }
  }

  async function rememberUrl(workspaceId: string, id: string, url: string, port: number): Promise<void> {
    let changed = false;
    await deps.store.update(workspaceId, (specs) => {
      const spec = specs.find((item) => item.id === id);
      if (!spec || (spec.url && spec.port)) return;
      if (!spec.url) spec.url = url;
      if (!spec.port) spec.port = port;
      spec.updatedAt = deps.now();
      changed = true;
    });
    if (changed) deps.changed(workspaceId);
  }

  function watch(entry: Live): void {
    let learned = false;
    let scan = "";
    const offOutput = deps.onOutput(entry.paneId, (chunk) => {
      appendLog(entry, chunk);
      if (learned) return;
      scan = (scan + chunk).slice(-4_096);
      const [first] = findLocalUrls(completeLines(scan));
      if (!first) return;
      learned = true;
      void rememberUrl(entry.workspaceId, entry.id, first.url, first.port).catch(() => undefined);
    });
    const offExit = deps.onExit(entry.paneId, (exitCode) => {
      if (live.get(key(entry.workspaceId, entry.id)) !== entry) return;
      entry.state = "exited";
      entry.exitCode = exitCode;
      deps.changed(entry.workspaceId);
    });
    entry.detach = () => {
      offOutput();
      offExit();
    };
  }

  /** What holds a port, in words an agent can act on. */
  async function describePortHolder(workspaceId: string, port: number, exceptId: string): Promise<string> {
    for (const [, entry] of live) {
      if (entry.workspaceId !== workspaceId || entry.id === exceptId || !isRunning(entry)) continue;
      const spec = await findSpec(workspaceId, entry.id);
      if (spec && (spec.port ?? portOfUrl(spec.url)) === port) {
        return `Port ${port} is already used by server "${entry.id}" of this workspace (pane ${entry.paneId}). Stop it first or choose another port.`;
      }
    }
    const owner = await deps.portOwner(port).catch(() => null);
    if (owner) {
      const pane = await deps.paneOfPid(owner.pid).catch(() => null);
      const what = `${owner.command ? `${owner.command} ` : ""}(pid ${owner.pid})`;
      return pane
        ? `Port ${port} is already in use by ${what} running in terminal pane ${pane}. Stop that process, or read it with codara_terminal_read, before starting another copy.`
        : `Port ${port} is already in use by ${what}. Stop that process or start the server on another port.`;
    }
    return `Port ${port} is already in use by another process. Stop it or start the server on another port.`;
  }

  async function waitReady(entry: Live, port: number | null, spec: () => Promise<DevServerSpec | null>): Promise<boolean> {
    const deadline = deps.now() + READY_WAIT_MS;
    while (deps.now() < deadline) {
      if (entry.state !== "running") return false;
      const current = await spec();
      const knownPort = port ?? current?.port ?? portOfUrl(current?.url ?? null);
      if (knownPort && (await deps.portAnswers(knownPort).catch(() => false))) return true;
      if (!knownPort && current?.url) return true;
      await deps.sleep(250);
    }
    return false;
  }

  type Launched = { done: StartResult } | { entry: Live; spec: DevServerSpec };

  async function start(input: DevServerStartInput & { wait?: boolean }): Promise<StartResult> {
    return settle(await serial(input.workspaceId, () => launch(input)), input.wait);
  }

  async function settle(launched: Launched, wait: boolean | undefined): Promise<StartResult> {
    if ("done" in launched) return launched.done;
    const { entry, spec: next } = launched;
    const { workspaceId, id } = entry;
    const ready = wait === false ? false : await waitReady(entry, null, () => findSpec(workspaceId, id));
    const server = await statusOf(workspaceId, (await findSpec(workspaceId, id)) ?? next);
    const result: StartResult = { server, alreadyRunning: false, ready };
    if (entry.state === "exited") result.output = tail(plainTerminalText(entry.log), 1_500);
    return result;
  }

  async function launch(input: DevServerStartInput): Promise<Launched> {
    const workspaceId = input.workspaceId;
    const typed = input.command === undefined ? undefined : splitEnvPrefix(checkCommand(input.command));
    const command = typed?.command;
    const port = checkPort(input.port);
    const url = checkUrl(input.url);
    const env = { ...checkEnv(typed?.env), ...checkEnv(input.env) };
    const requestedId = typeof input.id === "string" && input.id.trim() ? serverSlug(input.id) : null;
    if (input.id !== undefined && !requestedId) throw new ServerInputError("id must contain a letter or digit");

    const specs = await deps.store.list(workspaceId);
    let spec = requestedId ? specs.find((item) => item.id === requestedId) ?? null : null;
    if (!spec && !command) {
      throw new ServerInputError(
        requestedId
          ? `No server "${requestedId}" is saved for this workspace. Pass command to start one.`
          : "Pass the id of a saved server, or a command to start a new one.",
      );
    }
    const cwd = await resolveCwd(workspaceId, input.cwd, spec?.cwd);
    if (!spec && command) {
      spec = specs.find((item) => item.command === command && samePath(item.cwd, cwd)) ?? null;
    }
    const isNew = !spec;
    const id = spec?.id ?? requestedId ?? uniqueId(specs, suggestServerId(command ?? "", cwd));
    if (!SERVER_ID_RE.test(id)) throw new ServerInputError(`bad server id ${JSON.stringify(id)}`);

    const current = liveOf(workspaceId, id);
    if (current?.state === "pane" && !(await paneServerUp(current, spec))) {
      live.delete(key(workspaceId, id));
    } else if (isRunning(current)) {
      const status = await statusOf(workspaceId, spec ?? (await findSpec(workspaceId, id))!);
      return { done: { server: status, alreadyRunning: true, ready: status.health !== "down" } };
    }

    const next: DevServerSpec = {
      id,
      command: command ?? spec!.command,
      cwd,
      port: port ?? spec?.port ?? portOfUrl(url) ?? null,
      url: url ?? spec?.url ?? null,
      envNames: Object.keys(env).length ? Object.keys(env).sort() : spec?.envNames ?? [],
      autoStart: typeof input.autoStart === "boolean" ? input.autoStart : spec?.autoStart ?? false,
      source: spec?.source ?? input.source ?? "agent",
      createdAt: spec?.createdAt ?? deps.now(),
      updatedAt: deps.now(),
    };
    if (!isNew) {
      const same = specs.find((item) => item.id !== id && item.command === next.command && samePath(item.cwd, next.cwd));
      if (same) throw new ServerConflictError(`Server "${same.id}" already runs this command in ${next.cwd}. Start "${same.id}" instead.`);
    }

    const checkedPort = next.port;
    if (checkedPort && (await deps.portAnswers(checkedPort).catch(() => false))) {
      throw new ServerConflictError(await describePortHolder(workspaceId, checkedPort, id));
    }

    const remembered = envValues.get(key(workspaceId, id)) ?? {};
    const values = Object.keys(env).length ? env : remembered;
    envValues.set(key(workspaceId, id), values);

    await deps.store.update(workspaceId, (list) => {
      const index = list.findIndex((item) => item.id === id);
      if (index >= 0) list[index] = next;
      else list.push(next);
    });

    current?.detach();
    const startedAt = deps.now();
    const paneId = serverPaneId(workspaceId, id, startedAt);
    const entry: Live = {
      workspaceId,
      id,
      paneId,
      owned: true,
      pid: null,
      state: "running",
      startedAt,
      exitCode: null,
      log: "",
      dropped: 0,
      env: values,
      detach: () => undefined,
    };
    live.set(key(workspaceId, id), entry);
    watch(entry);
    try {
      await deps.spawn({ paneId, cwd: next.cwd, command: next.command, env: values });
    } catch (error) {
      entry.detach();
      live.delete(key(workspaceId, id));
      deps.changed(workspaceId);
      throw error;
    }
    deps.changed(workspaceId);
    return { entry, spec: next };
  }

  function uniqueId(specs: readonly DevServerSpec[], base: string): string {
    const taken = new Set(specs.map((spec) => spec.id));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1_000; n += 1) {
      const candidate = `${base.slice(0, 36)}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new ServerInputError("too many servers with this name");
  }

  function stop(workspaceId: string, rawId: string): Promise<{ server: DevServerStatus; alreadyStopped: boolean }> {
    return serial(workspaceId, () => stopNow(workspaceId, rawId));
  }

  async function stopNow(workspaceId: string, rawId: string): Promise<{ server: DevServerStatus; alreadyStopped: boolean }> {
    const id = serverSlug(rawId);
    const spec = await findSpec(workspaceId, id);
    if (!spec) throw new ServerInputError(`No server "${id}" is saved for this workspace.`);
    const entry = liveOf(workspaceId, id);
    if (!isRunning(entry)) {
      if (entry) {
        entry.detach();
        live.delete(key(workspaceId, id));
      }
      return { server: await statusOf(workspaceId, spec), alreadyStopped: true };
    }
    if (entry!.owned) {
      deps.kill(entry!.paneId);
      const deadline = deps.now() + STOP_WAIT_MS;
      while (deps.exists(entry!.paneId) && deps.now() < deadline) await deps.sleep(100);
    } else {
      await deps.stopPane(entry!.paneId, entry!.pid);
    }
    entry!.detach();
    live.delete(key(workspaceId, id));
    deps.changed(workspaceId);
    return { server: await statusOf(workspaceId, spec), alreadyStopped: false };
  }

  async function restart(workspaceId: string, id: string, options: { wait?: boolean; env?: Record<string, string> } = {}): Promise<StartResult> {
    const launched = await serial(workspaceId, async () => {
      await stopNow(workspaceId, id);
      const spec = await findSpec(workspaceId, serverSlug(id));
      const port = spec ? spec.port ?? portOfUrl(spec.url) : null;
      // A server needs a moment to let go of its port after it exits.
      if (port) {
        const deadline = deps.now() + STOP_WAIT_MS;
        while (deps.now() < deadline && (await deps.portAnswers(port).catch(() => false))) await deps.sleep(150);
      }
      return launch({ workspaceId, id, ...(options.env ? { env: options.env } : {}) });
    });
    return settle(launched, options.wait);
  }

  async function logs(workspaceId: string, rawId: string, since?: number): Promise<DevServerLogs> {
    const id = serverSlug(rawId);
    const entry = liveOf(workspaceId, id);
    if (!entry || !entry.owned) {
      if (!(await findSpec(workspaceId, id))) throw new ServerInputError(`No server "${id}" is saved for this workspace.`);
      return {
        id,
        paneId: entry?.paneId ?? null,
        text: entry ? "This server runs in a terminal pane; read it with codara_terminal_read." : "Not running since Codara started; no output yet.",
        cursor: 0,
        truncated: false,
      };
    }
    const end = entry.dropped + entry.log.length;
    const from = typeof since === "number" && Number.isFinite(since) ? Math.max(entry.dropped, Math.min(end, Math.floor(since))) : entry.dropped;
    const text = plainTerminalText(entry.log.slice(from - entry.dropped));
    if (text.length <= LOG_REPLY_CHARS) return { id, paneId: entry.paneId, text, cursor: end, truncated: false };
    const fullPath = await deps.writeLog(workspaceId, id, text);
    return {
      id,
      paneId: entry.paneId,
      text: `[${text.length - LOG_REPLY_CHARS} earlier characters in ${fullPath}]\n${tail(text, LOG_REPLY_CHARS)}`,
      cursor: end,
      truncated: true,
      fullPath,
    };
  }

  function save(input: DevServerSaveInput): Promise<DevServerStatus> {
    return serial(input.workspaceId, () => saveNow(input));
  }

  async function saveNow(input: DevServerSaveInput): Promise<DevServerStatus> {
    const id = serverSlug(input.id ?? "");
    if (!id) throw new ServerInputError("id is required");
    const existing = await findSpec(input.workspaceId, id);
    const typed = input.command === undefined ? null : splitEnvPrefix(checkCommand(input.command));
    const command = typed ? typed.command : existing?.command;
    if (!command) throw new ServerInputError(`No server "${id}" is saved for this workspace. Pass command to save one.`);
    const cwd = input.cwd === undefined && existing ? existing.cwd : await resolveCwd(input.workspaceId, input.cwd, existing?.cwd);
    const port = input.port === undefined ? existing?.port ?? null : checkPort(input.port);
    const url = input.url === undefined ? existing?.url ?? null : checkUrl(input.url);
    const next: DevServerSpec = {
      id,
      command,
      cwd,
      port: port ?? portOfUrl(url),
      url,
      envNames: typed && Object.keys(typed.env).length ? Object.keys(checkEnv(typed.env)).sort() : existing?.envNames ?? [],
      autoStart: typeof input.autoStart === "boolean" ? input.autoStart : existing?.autoStart ?? false,
      source: existing?.source ?? "user",
      createdAt: existing?.createdAt ?? deps.now(),
      updatedAt: deps.now(),
    };
    await deps.store.update(input.workspaceId, (specs) => {
      const clash = specs.find((item) => item.id !== id && item.command === next.command && samePath(item.cwd, next.cwd));
      if (clash) throw new ServerConflictError(`Server "${clash.id}" already runs this command in ${next.cwd}.`);
      const index = specs.findIndex((item) => item.id === id);
      if (index >= 0) specs[index] = next;
      else specs.push(next);
    });
    if (typed && Object.keys(typed.env).length) envValues.set(key(input.workspaceId, id), typed.env);
    deps.changed(input.workspaceId);
    return statusOf(input.workspaceId, next);
  }

  function forget(workspaceId: string, rawId: string): Promise<{ id: string; forgotten: boolean }> {
    return serial(workspaceId, () => forgetNow(workspaceId, rawId));
  }

  async function forgetNow(workspaceId: string, rawId: string): Promise<{ id: string; forgotten: boolean }> {
    const id = serverSlug(rawId);
    if (!(await findSpec(workspaceId, id))) return { id, forgotten: false };
    await stopNow(workspaceId, id);
    envValues.delete(key(workspaceId, id));
    await deps.store.update(workspaceId, (specs) => {
      const index = specs.findIndex((item) => item.id === id);
      if (index >= 0) specs.splice(index, 1);
    });
    deps.changed(workspaceId);
    return { id, forgotten: true };
  }

  /**
   * A server an agent or the user started in a terminal pane printed a local
   * URL: remember how to start it and that it runs there now.
   */
  function learn(input: LearnInput): Promise<string | null> {
    return serial(input.workspaceId, () => learnNow(input));
  }

  async function learnNow(input: LearnInput): Promise<string | null> {
    let command: string;
    let env: Record<string, string>;
    try {
      const typed = splitEnvPrefix(checkCommand(input.command));
      command = typed.command;
      env = checkEnv(typed.env);
    } catch {
      return null;
    }
    const specs = await deps.store.list(input.workspaceId);
    let spec = specs.find((item) => item.command === command && samePath(item.cwd, input.cwd)) ?? null;
    if (spec) {
      const owned = liveOf(input.workspaceId, spec.id);
      if (owned?.owned && owned.state === "running") return spec.id;
    }
    const id = spec?.id ?? uniqueId(specs, suggestServerId(command, input.cwd));
    await deps.store.update(input.workspaceId, (list) => {
      const existing = list.find((item) => item.id === id);
      if (existing) {
        if (!existing.url) existing.url = input.url;
        if (!existing.port) existing.port = input.port;
        existing.envNames = [...new Set([...existing.envNames, ...Object.keys(env)])].sort();
        existing.updatedAt = deps.now();
        return;
      }
      list.push({
        id,
        command,
        cwd: input.cwd,
        port: input.port,
        url: input.url,
        envNames: Object.keys(env).sort(),
        autoStart: false,
        source: input.source,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      });
    });
    if (Object.keys(env).length) envValues.set(key(input.workspaceId, id), { ...envValues.get(key(input.workspaceId, id)), ...env });
    const previous = live.get(key(input.workspaceId, id));
    previous?.detach();
    live.set(key(input.workspaceId, id), {
      workspaceId: input.workspaceId,
      id,
      paneId: input.paneId,
      owned: false,
      pid: input.pid ?? null,
      state: "pane",
      startedAt: deps.now(),
      exitCode: null,
      log: "",
      dropped: 0,
      env: {},
      detach: () => undefined,
    });
    deps.changed(input.workspaceId);
    return id;
  }

  /** Starts the workspace's auto-start servers, once per app session. */
  async function autoStart(workspaceId: string): Promise<string[]> {
    if (autoStarted.has(workspaceId)) return [];
    autoStarted.add(workspaceId);
    const started: string[] = [];
    for (const spec of await deps.store.list(workspaceId)) {
      if (!spec.autoStart) continue;
      try {
        const result = await start({ workspaceId, id: spec.id, wait: false });
        if (!result.alreadyRunning) started.push(spec.id);
      } catch {
        // A port already taken means a copy is running already; anything
        // else shows in the status view when the user opens it.
      }
    }
    return started;
  }

  /** Stops every server Codara owns, for quit. */
  function stopAll(): void {
    for (const entry of live.values()) {
      entry.detach();
      if (entry.owned && deps.exists(entry.paneId)) deps.kill(entry.paneId);
    }
    live.clear();
  }

  function runningCount(workspaceId?: string): number {
    let count = 0;
    for (const entry of live.values()) {
      if (workspaceId && entry.workspaceId !== workspaceId) continue;
      if (isRunning(liveOf(entry.workspaceId, entry.id))) count += 1;
    }
    return count;
  }

  /** The server a terminal session belongs to, for the status view and terminal tools. */
  function serverOfPane(paneId: string): { workspaceId: string; id: string; owned: boolean } | null {
    for (const entry of live.values()) {
      if (entry.paneId === paneId) return { workspaceId: entry.workspaceId, id: entry.id, owned: entry.owned };
    }
    return null;
  }

  return { list, start, stop, restart, logs, save, forget, learn, autoStart, stopAll, runningCount, serverOfPane };
}

export type ServerKeeper = ReturnType<typeof createServerKeeper>;

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
