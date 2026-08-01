// Pure policy for Cora's Pi worker extension: which bridge tools a worker may
// register, and which tool calls its automation access fence vetoes. Depends
// only on node builtins so the test harness can load it in isolation;
// worker.ts is the only production consumer.
//
// A chat worker's launch plan runs with SPARK_MCP_MODE=talk, an automation
// (loom) worker's with SPARK_MCP_MODE=worker plus SPARK_AUTOMATION_ID. Either
// way the bridge exposes a bounded roster, but this allowlist, not the
// env-selected roster, is what keeps manager orchestration tools
// (spawn_workers, complete, message_workers, ...) out of workers even if a
// future launch plan changes the mode. Whiteboard/board stay read-only for
// EVERY worker: the board is the calling chat's own kanban (scoped by
// SPARK_RUN_ID), so reading it is harmless context, while edits are the
// manager's call. Automation workers additionally get the two run-lifecycle
// tools their loop prompt references: codara_ask_user (blocked on a genuinely
// human decision) and codara_request_next_iteration (agent-loop continuation).

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export type WorkerEnv = Record<string, string | undefined>;

export function isAutomationWorker(env: WorkerEnv = process.env): boolean {
  return Boolean(env.SPARK_AUTOMATION_ID?.trim());
}

export function isWorkerSafeBridgeTool(
  name: string,
  automationWorker: boolean,
  env: WorkerEnv = process.env,
): boolean {
  if (env.CODARA_PI_PROJECT_POLICY === "untrusted-pull-request") return false;
  if (
    name.startsWith("codara_preview_") ||
    name.startsWith("codara_terminal_") ||
    name === "codara_whiteboard_get" ||
    name === "codara_board_get"
  ) {
    return true;
  }
  if (automationWorker) {
    return (
      name === "codara_ask_user" ||
      name === "codara_request_next_iteration"
    );
  }
  return false;
}

// ── Automation tool-access fence ────────────────────────────────────────────
// Loom worker nodes can pin an access preset ("edits" removes shell + web,
// "readonly" additionally removes the edit tool) and extra blockedTools. The
// launcher stamps them into CODARA_PI_WORKER_ACCESS /
// CODARA_PI_WORKER_BLOCKED_TOOLS and the extension's tool_call hook is the
// enforcement point: Pi's tools have no CLI deny flag, so the fence lives in
// the extension. The write tool survives every preset (the worker must write
// its mandatory final report), which makes readonly a guardrail against
// casual mutation, not a jail: write can still create or overwrite files, but
// only inside the containment roots below.
//
// Pi 0.82.0's native tools are exactly: bash, edit, find, grep, ls, read,
// write. The session also carries extension tools: web_search + url_context
// (pi-web-search), deep_search (bundled fallback), and the codara_* bridge
// roster. The fence names below are asserted against that inventory in
// scripts/test-pi-cora-extension.cjs.
//
// blockedTools entries use the familiar bare vocabulary (Bash, WebSearch,
// Edit, Write, ...). They are mapped onto the real tool names; a handful need
// explicit aliases.
const FENCE_ALIASES: Record<string, string[]> = {
  websearch: ["web_search", "deep_search", "url_context"],
  webfetch: ["url_context", "deep_search"],
  glob: ["find"],
  multiedit: ["edit"],
};
const FENCE_WEB_AND_SHELL = ["bash", "web_search", "deep_search", "url_context"];
const FENCE_READONLY_EXTRA = ["edit"];
// Bridge tools that ARE a shell or arbitrary code execution: any fenced preset
// blocks them ("no shell/web" must include the terminal tab that takes a
// command and the preview's JS evaluator; codara_preview_run is included
// because its step batch can embed evaluate steps).
const FENCE_BRIDGE_SHELL = [
  "codara_terminal_create",
  "codara_terminal_write",
  "codara_terminal_read",
  "codara_terminal_close",
  "codara_preview_evaluate",
  "codara_preview_run",
];
// Bridge tools that mutate page state; blocked for readonly only (navigation,
// screenshots, snapshots, console, and network inspection stay available).
const FENCE_BRIDGE_MUTATING = [
  "codara_preview_click",
  "codara_preview_drag",
  "codara_preview_key",
  "codara_preview_mouse",
  "codara_preview_press_key",
  "codara_preview_type",
  "codara_preview_upload",
];

function fenceAccess(env: WorkerEnv): "edits" | "readonly" | undefined {
  const access = env.CODARA_PI_WORKER_ACCESS?.trim().toLowerCase();
  return access === "edits" || access === "readonly" ? access : undefined;
}

export function fencedToolNames(env: WorkerEnv = process.env): Set<string> {
  const blocked = new Set<string>();
  const access = fenceAccess(env);
  if (access) {
    for (const name of FENCE_WEB_AND_SHELL) blocked.add(name);
    for (const name of FENCE_BRIDGE_SHELL) blocked.add(name);
  }
  if (access === "readonly") {
    for (const name of FENCE_READONLY_EXTRA) blocked.add(name);
    for (const name of FENCE_BRIDGE_MUTATING) blocked.add(name);
  }
  for (const raw of (env.CODARA_PI_WORKER_BLOCKED_TOOLS ?? "").split(",")) {
    const bare = raw.trim();
    if (!bare) continue;
    const flat = bare.toLowerCase();
    const snake = bare.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    blocked.add(flat);
    blocked.add(snake);
    for (const alias of FENCE_ALIASES[flat] ?? []) blocked.add(alias);
  }
  return blocked;
}

// ── Write containment ───────────────────────────────────────────────────────
// Pi's write/edit tools accept absolute paths anywhere, and the old codex
// Seatbelt sandbox is gone, so a fenced (edits/readonly) worker must have its
// file mutations contained. Allowed roots: the session cwd (the workspace)
// plus the dirs the launcher stamps into CODARA_PI_WORKER_WRITE_ALLOW (a JSON
// array: the attempt dir holding the mandatory final report, and the shared
// chat-board dir for collab participants). Everything else is refused with a
// recovery hint. Containment canonicalizes through the nearest EXISTING
// ancestor's realpath so a symlink inside the workspace cannot escape it.
const CONTAINED_PATH_TOOLS = new Set(["read", "find", "grep", "ls", "write", "edit"]);

function parseAllowedDirs(env: WorkerEnv): string[] {
  const raw = env.CODARA_PI_WORKER_WRITE_ALLOW?.trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === "string" && d.trim().length > 0);
  } catch {
    return [];
  }
}

function parseAllowedFiles(env: WorkerEnv): string[] {
  const raw = env.CODARA_PI_WORKER_WRITE_ALLOW_FILES?.trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === "string" && d.trim().length > 0);
  } catch {
    return [];
  }
}

/** Canonicalize a path that may not exist yet: realpath the nearest existing
 *  ancestor, then re-append the non-existing remainder. */
function canonicalize(target: string): string {
  let existing = target;
  const suffix: string[] = [];
  for (;;) {
    if (existsSync(existing)) break;
    const parent = dirname(existing);
    if (parent === existing) break; // filesystem root
    suffix.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync(existing);
  } catch {
    /* keep the resolved form; containment still checks the resolved prefix */
  }
  return suffix.length > 0 ? resolve(real, ...suffix) : real;
}

function isContained(target: string, root: string): boolean {
  const t = canonicalize(target);
  const r = canonicalize(root);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

function toolTargetPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** The tool_call veto for one call, or undefined to let it run. Checks the
 *  blocked-name fence first, then write containment for fenced workers. */
export function fenceDecision(
  toolName: unknown,
  input: unknown,
  fence: ReadonlySet<string>,
  env: WorkerEnv = process.env,
): { block: true; reason: string } | undefined {
  const name = String(toolName ?? "").toLowerCase();
  if (fence.has(name)) {
    const access = env.CODARA_PI_WORKER_ACCESS?.trim();
    return {
      block: true,
      reason:
        `The ${String(toolName)} tool is disabled for this automation worker` +
        `${access ? ` (access preset "${access}")` : " (blocked by its worker config)"}. ` +
        "Use the remaining tools, or note the limitation in your final report.",
    };
  }
  // Containment applies only when a preset armed the fence; blockedTools-only
  // workers keep full path reach on the tools they still have. Read/search
  // tools are contained as well: a pull request must not turn a worker into a
  // reader for ~/.ssh, ~/.codex, sibling worktrees, or other local secrets.
  if (!fenceAccess(env) || !CONTAINED_PATH_TOOLS.has(name)) return undefined;
  const rawTarget = toolTargetPath(input);
  // Pi's find/grep/ls default to cwd when path is omitted. That is safe and
  // avoids rejecting their normal workspace form.
  if (!rawTarget) return undefined;
  const cwd = process.cwd();
  const target = isAbsolute(rawTarget) ? rawTarget : resolve(cwd, rawTarget);
  const roots = [cwd, ...parseAllowedDirs(env)];
  const mutation = name === "write" || name === "edit";
  const exactAllowedFiles = parseAllowedFiles(env).map((file) => canonicalize(resolve(file)));
  const targetCanonical = canonicalize(target);
  const exactFileAllowed = mutation && exactAllowedFiles.includes(targetCanonical);
  if (roots.some((root) => isContained(target, root)) || exactFileAllowed) {
    if (!exactFileAllowed && isContained(target, resolve(cwd, ".git"))) {
      return {
        block: true,
        reason: "Refused to access Git administrative data from a fenced worker.",
      };
    }
    if (mutation && existsSync(target)) {
      try {
        const stat = lstatSync(target);
        if (stat.isFile() && stat.nlink > 1) {
          return {
            block: true,
            reason: "Refused to modify a multiply-linked file from a fenced worker.",
          };
        }
      } catch {
        return {
          block: true,
          reason: "Could not safely inspect the target path for this fenced worker.",
        };
      }
    }
    return undefined;
  }
  return {
    block: true,
    reason:
      `Refused to use ${name} outside this worker's workspace: ${rawTarget}. ` +
      `Stay inside the working directory (${cwd}) or the run's report directory, ` +
      "or note the limitation in your final report.",
  };
}
