import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  CodaraBoxConnectInfoResult,
  CodaraBoxesErrorCode,
  CodaraBoxesListResult,
  CodaraBoxSummary,
  RemoteHostConfig,
} from "@shared/remote";
import { isValidHostId } from "@shared/remote";
import { resolveBinary } from "../binary-resolver";

// Codara Cloud boxes through the `codaracloud` CLI, the way github-cli.ts
// reaches `gh`: the CLI owns sign-in, keys and the wake protocol; Studio only
// reads its JSON and spawns what it prints. No token ever passes through here.

export const CODARA_CLI_NAME = "codaracloud";
export const CODARA_CLI_INSTALL_URL = "https://codaracloud.com/docs";
export const BOXES_LIST_TIMEOUT_MS = 15_000;
export const BOXES_SSH_CONFIG_TIMEOUT_MS = 60_000;
// A cold wake can wait for a new server; the CLI's own ceiling is 15 minutes.
export const BOXES_WAKE_TIMEOUT_MS = 16 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const BOX_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodaraBoxesDeps {
  /** Absolute path of the CLI, or null when it is not installed. */
  resolveCli?: () => Promise<string | null>;
}

export class CodaraBoxesError extends Error {
  constructor(
    readonly code: CodaraBoxesErrorCode,
    message: string,
    readonly installUrl?: string,
  ) {
    super(message);
    this.name = "CodaraBoxesError";
  }
}

export function isBoxId(value: unknown): value is string {
  return typeof value === "string" && BOX_ID_RE.test(value);
}

async function requireCli(deps: CodaraBoxesDeps): Promise<string> {
  const path = await (deps.resolveCli ?? (() => resolveBinary(CODARA_CLI_NAME)))();
  if (!path) {
    throw new CodaraBoxesError(
      "cli_missing",
      "The Codara Cloud CLI (codaracloud) is not installed.",
      CODARA_CLI_INSTALL_URL,
    );
  }
  return path;
}

// The CLI prints API messages on stderr; map the ones the picker can act on.
function classifyFailure(stderr: string, fallback: string): CodaraBoxesError {
  const text = stderr.trim();
  if (/boxes_disabled|boxes are not enabled/i.test(text)) {
    return new CodaraBoxesError("boxes_disabled", "Codara Boxes are not enabled yet.");
  }
  if (/codaracloud login|not (signed|logged) in|unauthori[sz]ed|sign in again|\b401\b/i.test(text)) {
    return new CodaraBoxesError(
      "not_signed_in",
      "You are not signed in to Codara Cloud. Run codaracloud login in a terminal, then try again.",
    );
  }
  // The CLI prefixes its final failure with "Error: "; the picker adds its own framing.
  const line = text.split(/\r?\n/).filter(Boolean).pop()?.replace(/^Error:\s*/, "");
  return new CodaraBoxesError("failed", line ? line.slice(0, 300) : fallback);
}

function runCli(
  cli: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT") {
          reject(new CodaraBoxesError("cli_missing", "The Codara Cloud CLI (codaracloud) is not installed.", CODARA_CLI_INSTALL_URL));
        } else if (e.killed) {
          reject(new CodaraBoxesError("failed", "The Codara Cloud CLI did not answer in time."));
        } else {
          reject(classifyFailure(String(stderr), "The Codara Cloud CLI failed."));
        }
      },
    );
  });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseBoxList(stdout: string): CodaraBoxSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CodaraBoxesError("failed", "The Codara Cloud CLI returned something that is not JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new CodaraBoxesError("failed", "The Codara Cloud CLI returned an unexpected box list.");
  }
  const boxes: CodaraBoxSummary[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    const id = str(b.id);
    const name = str(b.name);
    if (!id || !isBoxId(id) || !name) continue;
    boxes.push({
      id,
      name,
      clientSlug: str(b.client_slug) ?? "",
      projectSlug: str(b.project_slug),
      environmentSlug: str(b.environment_slug),
      region: str(b.region),
      phase: str(b.phase) ?? "Unknown",
      message: str(b.message),
      canConnect: b.can_connect === true,
    });
  }
  return boxes;
}

export async function listCodaraBoxes(deps: CodaraBoxesDeps = {}): Promise<CodaraBoxesListResult> {
  try {
    const cli = await requireCli(deps);
    const { stdout } = await runCli(cli, ["boxes", "list", "-o", "json"], BOXES_LIST_TIMEOUT_MS);
    return { ok: true, boxes: parseBoxList(stdout) };
  } catch (err) {
    return failure(err);
  }
}

function failure(err: unknown): { ok: false; code: CodaraBoxesErrorCode; message: string; installUrl?: string } {
  if (err instanceof CodaraBoxesError) {
    return { ok: false, code: err.code, message: err.message, ...(err.installUrl ? { installUrl: err.installUrl } : {}) };
  }
  return { ok: false, code: "failed", message: "The Codara Cloud CLI failed." };
}

function validArgv(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= 32 &&
    v.every((a) => typeof a === "string" && a.length > 0 && a.length <= 4096 && !a.includes("\0")) &&
    isAbsolute(v[0])
  );
}

/** Build the host entry from one `boxes ssh-config --print -o json` record. */
export function hostFromSshConfigJson(boxId: string, stdout: string): RemoteHostConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CodaraBoxesError("failed", "The Codara Cloud CLI returned something that is not JSON.");
  }
  const record = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  const box = record?.box as Record<string, unknown> | undefined;
  const alias = str(record?.host);
  const user = str(record?.user);
  const argv = record?.proxy_command;
  const hostKeyAlias = str(record?.host_key_alias);
  if (
    !record ||
    !alias ||
    !isValidHostId(alias) ||
    !user ||
    !validArgv(argv) ||
    !hostKeyAlias ||
    (box && box.id !== boxId)
  ) {
    throw new CodaraBoxesError("failed", "The Codara Cloud CLI returned an unexpected SSH configuration.");
  }
  const identity = str(record.identity_file);
  return {
    id: alias,
    host: alias,
    port: 22,
    username: user,
    ...(identity ? { identityFile: identity } : {}),
    source: "codara-cloud",
    proxyCommand: argv,
    hostKeyAlias,
    codaraBoxId: boxId,
  };
}

export async function codaraBoxConnectInfo(
  boxId: string,
  deps: CodaraBoxesDeps = {},
): Promise<CodaraBoxConnectInfoResult> {
  try {
    if (!isBoxId(boxId)) throw new CodaraBoxesError("failed", "That is not a box id.");
    const cli = await requireCli(deps);
    const { stdout } = await runCli(
      cli,
      ["boxes", "ssh-config", boxId, "--print", "-o", "json"],
      BOXES_SSH_CONFIG_TIMEOUT_MS,
    );
    return { ok: true, host: hostFromSshConfigJson(boxId, stdout) };
  } catch (err) {
    return failure(err);
  }
}

export interface WakeOptions extends CodaraBoxesDeps {
  /** One stderr line from the CLI, e.g. "Waking dev: starting the box". */
  onPhase?: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * `codaracloud boxes wake <id> --wait 15m`: resolves when the box is awake.
 * The CLI follows the wake protocol; its stderr phase lines are the progress.
 */
export async function wakeCodaraBox(boxId: string, opts: WakeOptions = {}): Promise<void> {
  if (!isBoxId(boxId)) throw new CodaraBoxesError("failed", "That is not a box id.");
  const cli = await requireCli(opts);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli, ["boxes", "wake", boxId, "--wait", "15m"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let tail = "";
    let pending = "";
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const kill = () => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    };
    const onAbort = () => {
      kill();
      finish(new Error("The box wake was cancelled."));
    };
    const timer = setTimeout(() => {
      kill();
      finish(new CodaraBoxesError("failed", "The box did not start in time."));
    }, opts.timeoutMs ?? BOXES_WAKE_TIMEOUT_MS);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-2048);
      pending += text;
      let nl: number;
      while ((nl = pending.search(/\r?\n/)) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl).replace(/^\r?\n/, "");
        if (line) opts.onPhase?.(line);
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(
        err.code === "ENOENT"
          ? new CodaraBoxesError("cli_missing", "The Codara Cloud CLI (codaracloud) is not installed.", CODARA_CLI_INSTALL_URL)
          : err,
      );
    });
    child.on("close", (code) => {
      const rest = pending.trim();
      if (rest) opts.onPhase?.(rest);
      if (code === 0) finish();
      else finish(classifyFailure(tail, "The box could not be woken."));
    });
  });
}
