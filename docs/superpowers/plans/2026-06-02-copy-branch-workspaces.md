# Copy-branch Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Create copy branch" action that forks the current workspace's repo into an isolated git **worktree** on a fresh city-named branch off `main`, installs deps via a per-repo setup command, and opens it as a first-class Spark workspace — with worktree-aware teardown.

**Architecture:** Main owns a new `git-worktrees.ts` of pure `runGit`-based primitives exposed via `git:*` IPC channels. The renderer (`App.tsx`) owns the lifecycle flow: call the primitive → register a `Workspace` (with `copyBranch` provenance) → spawn the setup terminal via the existing `tabs.newTerminalTab(cwd, autorun)` → activate. Deleting a copy-branch workspace runs `git worktree remove`. Source Control already works inside worktrees because every git op is `cwd`-keyed.

**Tech Stack:** Electron + electron-vite, React 18, TypeScript, `node-pty`, raw `git` via `execFile`. No unit-test runner — the one isolated-testable module is verified with a Node integration script that bundles the TS via `esbuild` (present in `node_modules`) and exercises it against a throwaway git repo. Everything else is verified with `npm run typecheck` plus a manual smoke checklist.

**Spec:** `docs/superpowers/specs/2026-06-02-copy-branch-workspaces-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | `Workspace.copyBranch`, `GitCopyWorktreeResult`, `AppPreferences.copyBranchSetupCommandByRepo`, `DEFAULT_COPY_BRANCH_SETUP_COMMAND` |
| `src/main/git-worktrees.ts` *(new)* | Pure git+fs primitives: `resolveDefaultBranch`, `pickCity`, `createCopyWorktree`, `removeCopyWorktree`, `CITY_SLUGS` |
| `scripts/test-worktrees.cjs` *(new)* | Node integration test for `git-worktrees.ts` against a temp repo |
| `src/main/ipc.ts` | `git:createCopyWorktree`, `git:removeCopyWorktree` handlers + lazy `getGitWorktrees()` |
| `src/preload/index.ts` | `git.createCopyWorktree`, `git.removeCopyWorktree` bridge methods |
| `src/main/storage.ts` | Preserve `copyBranch` in `normalize()` |
| `src/main/preferences-store.ts` | Normalize/carry `copyBranchSetupCommandByRepo` |
| `src/renderer/src/components/CopyBranchDialogs.tsx` *(new)* | `CopyBranchDeleteDialog` modal + `CopyBranchErrorToast` |
| `src/renderer/src/components/WorkspaceRail.tsx` | `⋯` → popover menu (Edit / Create copy branch / Delete); new props |
| `src/renderer/src/App.tsx` | `createCopyBranchWs`, worktree-aware delete, render dialogs, thread props, pass `workspaceCwd` to Settings |
| `src/renderer/src/components/SettingsDialog.tsx` | Per-repo setup-command field in the General tab |

Implement tasks in order — later tasks depend on the types and module from earlier ones.

---

## Task 1: Shared types

**Files:**
- Modify: `src/shared/types.ts` (the `Workspace` interface ~line 56; the `AppPreferences` interface line 175; `DEFAULT_PREFERENCES` line 272; add `GitOpResult` neighbour ~line 619)

- [ ] **Step 1: Add `copyBranch` to the `Workspace` interface**

Find (around line 56):

```ts
export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  color: string;
  workers: Worker[];
}
```

Replace with:

```ts
export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  color: string;
  workers: Worker[];
  // Present only on workspaces created via "Create copy branch": this
  // workspace's cwd is a git worktree forked from `repoCwd`. Its presence is
  // what makes delete remove the worktree instead of just dropping the row.
  copyBranch?: {
    repoCwd: string; // source repo the worktree was forked from
    branch: string; // branch checked out in this worktree (== city in v1)
    baseBranch: string; // what it forked from, e.g. "main"
    city: string; // generated slug (directory + branch name)
    createdAt: string; // ISO timestamp
  };
}
```

- [ ] **Step 2: Add the copy-worktree IPC result type**

Find (around line 619):

```ts
export type GitOpResult = { ok: true } | { ok: false; error: string };
```

Add immediately after it:

```ts
// Result of git:createCopyWorktree. Shared so renderer + main agree on shape.
export type GitCopyWorktreeResult =
  | { ok: true; path: string; branch: string; city: string; baseBranch: string }
  | { ok: false; error: string };
```

- [ ] **Step 3: Add the per-repo setup-command preference**

In the `AppPreferences` interface (ends around line 194, after `notificationChannels`), add a field before the closing brace:

```ts
  // "Create copy branch" setup command, keyed by absolute repo cwd. Run live
  // in a terminal in the new worktree after creation. Repos with no entry use
  // DEFAULT_COPY_BRANCH_SETUP_COMMAND.
  copyBranchSetupCommandByRepo: Record<string, string>;
```

Immediately above `export const DEFAULT_PREFERENCES` (line 272) add:

```ts
export const DEFAULT_COPY_BRANCH_SETUP_COMMAND = "npm install";
```

In the `DEFAULT_PREFERENCES` object (line 272), add the default before the closing brace:

```ts
  copyBranchSetupCommandByRepo: {},
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no errors). The new optional fields don't break existing code; `DEFAULT_PREFERENCES` now satisfies `AppPreferences`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts
git commit -m "Add copy-branch types: Workspace.copyBranch, GitCopyWorktreeResult, setup-command pref"
```

---

## Task 2: `git-worktrees.ts` module (TDD via integration script)

**Files:**
- Create: `src/main/git-worktrees.ts`
- Create: `scripts/test-worktrees.cjs`
- Modify: `package.json` (add `test:worktrees` script)

- [ ] **Step 1: Write the failing test**

Create `scripts/test-worktrees.cjs`:

```js
// Integration test for src/main/git-worktrees.ts. There is no unit runner in
// this repo, so we bundle the TS module with esbuild (a vite dependency, so
// already in node_modules) into a temp CJS file and exercise it against a
// throwaway git repo. The module's only runtime import is ./git-exec (node
// child_process); the @shared/types import is type-only and erased by esbuild.
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function main() {
  const esbuild = require("esbuild");
  const outFile = path.join(os.tmpdir(), `spark-worktrees-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "main", "git-worktrees.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    external: ["electron"],
    logLevel: "silent",
  });
  const wt = require(outFile);

  const repo = mkdtempSync(path.join(os.tmpdir(), "spark-repo-"));
  const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), "spark-wts-"));
  try {
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repo, "README.md"), "# test\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);

    assert.strictEqual(
      await wt.resolveDefaultBranch(repo),
      "main",
      "default branch should be main",
    );

    const r = await wt.createCopyWorktree({ repoCwd: repo, worktreesRoot });
    assert.ok(r.ok, `create failed: ${r.ok ? "" : r.error}`);
    assert.ok(existsSync(r.path), "worktree path should exist");
    assert.strictEqual(
      git(r.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      r.branch,
      "worktree HEAD should be the city branch",
    );
    assert.strictEqual(
      git(r.path, ["status", "--porcelain"]),
      "",
      "fresh worktree should be clean",
    );
    assert.strictEqual(r.baseBranch, "main", "baseBranch should be main");

    const city2 = await wt.pickCity(repo, worktreesRoot);
    assert.notStrictEqual(city2, r.city, "pickCity should not reuse the created city");

    const rm = await wt.removeCopyWorktree({
      repoCwd: repo,
      worktreePath: r.path,
      branch: r.branch,
      deleteBranch: true,
    });
    assert.ok(rm.ok, `remove failed: ${rm.ok ? "" : rm.error}`);
    assert.ok(!existsSync(r.path), "worktree path should be gone after remove");
    const branches = git(repo, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]).split("\n");
    assert.ok(!branches.includes(r.branch), "branch should be deleted");

    console.log("PASS: git-worktrees");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreesRoot, { recursive: true, force: true });
    try {
      rmSync(outFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-worktrees.cjs`
Expected: FAIL — esbuild errors because `src/main/git-worktrees.ts` does not exist yet (`Could not resolve "…/git-worktrees.ts"`).

- [ ] **Step 3: Implement the module**

Create `src/main/git-worktrees.ts`:

```ts
import { existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GitCopyWorktreeResult, GitOpResult } from "@shared/types";
import { errorText, readGitText, runGit } from "./git-exec";

// Worktree provisioning for the "Create copy branch" workspace action. Pure
// git + fs — NO electron import — so the path base (sparkHome) is passed in by
// the caller (ipc.ts). Keep this dependency-light: the integration test bundles
// it with esbuild and the only runtime import is ./git-exec.

// City slugs used to name copy-branch worktrees, à la Conductor. Lowercase,
// hyphenated, filesystem- and branch-name-safe.
const CITY_SLUGS = [
  "lisbon", "porto", "madrid", "seville", "valencia", "bilbao", "granada",
  "paris", "lyon", "marseille", "nice", "bordeaux", "nantes", "toulouse",
  "berlin", "munich", "hamburg", "cologne", "leipzig", "dresden", "bremen",
  "rome", "milan", "naples", "turin", "venice", "verona", "bologna", "genoa",
  "amsterdam", "rotterdam", "utrecht", "haarlem", "leiden", "delft",
  "vienna", "graz", "salzburg", "linz", "innsbruck",
  "zurich", "geneva", "basel", "bern", "lausanne",
  "oslo", "bergen", "stavanger", "tromso",
  "stockholm", "gothenburg", "malmo", "uppsala",
  "copenhagen", "aarhus", "odense", "aalborg",
  "helsinki", "espoo", "tampere", "turku",
  "dublin", "cork", "galway", "limerick",
  "london", "manchester", "bristol", "leeds", "york", "bath", "oxford",
  "edinburgh", "glasgow", "aberdeen", "dundee",
  "lisbon-bay", "warsaw", "krakow", "gdansk", "wroclaw", "poznan",
  "prague", "brno", "ostrava",
  "budapest", "debrecen", "szeged",
  "athens", "thessaloniki", "patras",
  "tokyo", "osaka", "kyoto", "nagoya", "sapporo", "fukuoka", "sendai", "kobe",
  "seoul", "busan", "incheon", "daegu",
  "taipei", "kaohsiung", "tainan",
  "singapore", "bangkok", "hanoi", "jakarta", "manila",
  "sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra", "hobart",
  "auckland", "wellington", "christchurch",
  "toronto", "montreal", "vancouver", "calgary", "ottawa", "quebec", "halifax",
  "boston", "seattle", "portland", "austin", "denver", "chicago", "atlanta",
  "phoenix", "dallas", "houston", "miami", "detroit", "nashville",
  "tunis", "cairo", "casablanca", "marrakech", "nairobi", "lagos", "accra",
  "rio", "saopaulo", "lima", "bogota", "quito", "santiago", "montevideo",
  "reykjavik", "tallinn", "riga", "vilnius",
];

export interface CreateCopyWorktreeInput {
  repoCwd: string;
  // Base dir for THIS repo's worktrees, e.g. ~/.SparkAgent/worktrees/<repo>.
  // Caller (ipc.ts) computes it from sparkHome so this module stays
  // electron-free and testable.
  worktreesRoot: string;
  baseBranch?: string;
  city?: string;
}

export interface RemoveCopyWorktreeInput {
  repoCwd: string;
  worktreePath: string;
  branch: string;
  force?: boolean;
  deleteBranch?: boolean;
}

async function branchExists(repoCwd: string, name: string): Promise<boolean> {
  try {
    await runGit(repoCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

// origin/HEAD → local main → local master → current branch → "main".
export async function resolveDefaultBranch(repoCwd: string): Promise<string> {
  const originHead = await readGitText(repoCwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead.startsWith("origin/")) {
    return originHead.slice("origin/".length);
  }
  if (await branchExists(repoCwd, "main")) return "main";
  if (await branchExists(repoCwd, "master")) return "master";
  const current = await readGitText(repoCwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current || "main";
}

async function localBranchNames(repoCwd: string): Promise<Set<string>> {
  const out = await readGitText(repoCwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return new Set(
    out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function existingWorktreeDirs(worktreesRoot: string): Promise<Set<string>> {
  try {
    const entries = await readdir(worktreesRoot, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}

// Pick a city slug not already used as a local branch name or an existing
// worktree directory for this repo. If every base slug is taken, append a
// numeric suffix to a random base until one is free.
export async function pickCity(repoCwd: string, worktreesRoot: string): Promise<string> {
  const used = new Set<string>([
    ...(await localBranchNames(repoCwd)),
    ...(await existingWorktreeDirs(worktreesRoot)),
  ]);
  const free = CITY_SLUGS.filter((c) => !used.has(c));
  if (free.length > 0) {
    return free[Math.floor(Math.random() * free.length)];
  }
  const base = CITY_SLUGS[Math.floor(Math.random() * CITY_SLUGS.length)];
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export async function createCopyWorktree(
  input: CreateCopyWorktreeInput,
): Promise<GitCopyWorktreeResult> {
  try {
    const baseBranch = input.baseBranch?.trim() || (await resolveDefaultBranch(input.repoCwd));
    const city = input.city?.trim() || (await pickCity(input.repoCwd, input.worktreesRoot));
    const path = join(input.worktreesRoot, city);
    if (existsSync(path)) {
      return { ok: false, error: `Worktree path already exists: ${path}` };
    }
    mkdirSync(input.worktreesRoot, { recursive: true });
    await runGit(input.repoCwd, ["worktree", "add", path, "-b", city, baseBranch]);
    return { ok: true, path, branch: city, city, baseBranch };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export async function removeCopyWorktree(input: RemoveCopyWorktreeInput): Promise<GitOpResult> {
  try {
    await runGit(input.repoCwd, [
      "worktree",
      "remove",
      ...(input.force ? ["--force"] : []),
      input.worktreePath,
    ]);
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  // Best-effort prune of any stale admin entry left behind.
  try {
    await runGit(input.repoCwd, ["worktree", "prune"]);
  } catch {
    /* ignore — prune failure is not fatal */
  }
  if (input.deleteBranch) {
    try {
      // Safe delete: git refuses (-d) if the branch has unmerged commits.
      await runGit(input.repoCwd, ["branch", "-d", input.branch]);
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Add the npm script, then run the test to verify it passes**

In `package.json`, inside `"scripts"`, add after the `inspect-run` line:

```json
    "test:worktrees": "node scripts/test-worktrees.cjs",
```

Run: `npm run test:worktrees`
Expected: PASS — prints `PASS: git-worktrees`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/main/git-worktrees.ts scripts/test-worktrees.cjs package.json
git commit -m "Add git-worktrees module + integration test for copy-branch workspaces"
```

---

## Task 3: IPC + preload wiring

**Files:**
- Modify: `src/main/ipc.ts` (lazy getters block ~line 40-58; git branches handler block ~line 657)
- Modify: `src/preload/index.ts` (git block, after `mergeBranch` ~line 341)

- [ ] **Step 1: Add the lazy module getter**

In `src/main/ipc.ts`, after the `getGitApply()` getter (around line 58), add:

```ts
async function getGitWorktrees(): Promise<typeof import("./git-worktrees")> {
  return import("./git-worktrees");
}
```

- [ ] **Step 2: Add the IPC handlers**

In `src/main/ipc.ts`, immediately after the `git:mergeBranch` handler (ends ~line 657), add. Note: this needs `sparkHome`, `join`, `basename`, `invalidateGitCache` in scope — `import { sparkHome } from "./spark-home";` and `import { basename, join } from "node:path";` at the top if not already imported, and `const { invalidateGitCache } = await getGitOps();` is available via the ops module:

```ts
  // ── Copy-branch worktrees ───────────────────────────────────────────────────
  ipcMain.handle(
    "git:createCopyWorktree",
    async (
      _e,
      input: { repoCwd: string; baseBranch?: string; city?: string },
    ): Promise<GitCopyWorktreeResult> => {
      const { createCopyWorktree } = await getGitWorktrees();
      const worktreesRoot = join(sparkHome(), "worktrees", basename(input.repoCwd));
      const result = await createCopyWorktree({
        repoCwd: input.repoCwd,
        worktreesRoot,
        baseBranch: input.baseBranch,
        city: input.city,
      });
      if (result.ok) {
        // The new branch is a shared ref — refresh the source repo's panel.
        const { invalidateGitCache } = await getGitOps();
        invalidateGitCache(input.repoCwd);
      }
      return result;
    },
  );

  ipcMain.handle(
    "git:removeCopyWorktree",
    async (
      _e,
      input: {
        repoCwd: string;
        worktreePath: string;
        branch: string;
        force?: boolean;
        deleteBranch?: boolean;
      },
    ): Promise<GitOpResult> => {
      const { removeCopyWorktree } = await getGitWorktrees();
      const result = await removeCopyWorktree(input);
      const { invalidateGitCache } = await getGitOps();
      invalidateGitCache(input.repoCwd);
      return result;
    },
  );
```

Ensure `GitCopyWorktreeResult` is part of the existing `@shared/types` import in `ipc.ts` (add it to the type import list alongside `GitOpResult`). Add `import { sparkHome } from "./spark-home";` and `import { basename, join } from "node:path";` at the top if they are not already imported (check the existing imports first — `join` may already be imported from `node:path`).

- [ ] **Step 3: Add the preload bridge methods**

In `src/preload/index.ts`, in the `git:` block right after `mergeBranch` (line 340-341), add:

```ts
    // Copy-branch worktrees
    createCopyWorktree: (
      repoCwd: string,
      opts?: { baseBranch?: string; city?: string },
    ): Promise<GitCopyWorktreeResult> =>
      ipcRenderer.invoke("git:createCopyWorktree", {
        repoCwd,
        baseBranch: opts?.baseBranch,
        city: opts?.city,
      }),
    removeCopyWorktree: (input: {
      repoCwd: string;
      worktreePath: string;
      branch: string;
      force?: boolean;
      deleteBranch?: boolean;
    }): Promise<GitOpResult> => ipcRenderer.invoke("git:removeCopyWorktree", input),
```

Ensure `GitCopyWorktreeResult` is added to the `@shared/types` type import at the top of `src/preload/index.ts` (next to `GitOpResult`).

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS. The handler return types match the shared types; the preload methods are exposed under `window.spark.git`.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "Wire git:createCopyWorktree / git:removeCopyWorktree IPC + preload"
```

---

## Task 4: Persist `copyBranch` through storage normalize

**Files:**
- Modify: `src/main/storage.ts` (`normalize()` ~line 72)

- [ ] **Step 1: Preserve `copyBranch` in `normalize()`**

Find (line 72):

```ts
function normalize(w: Workspace): Workspace {
  return {
    id: w.id,
    name: w.name ?? "workspace",
    cwd: w.cwd ?? app.getPath("home"),
    color: w.color ?? "#F0C419",
    workers: Array.isArray(w.workers)
      ? w.workers.filter((worker) => worker.kind !== "orchestration")
      : [],
  };
}
```

Replace with:

```ts
function normalize(w: Workspace): Workspace {
  const normalized: Workspace = {
    id: w.id,
    name: w.name ?? "workspace",
    cwd: w.cwd ?? app.getPath("home"),
    color: w.color ?? "#F0C419",
    workers: Array.isArray(w.workers)
      ? w.workers.filter((worker) => worker.kind !== "orchestration")
      : [],
  };
  // Carry copy-branch provenance through verbatim when it is a well-formed
  // object; without this the field is silently dropped on every state:save and
  // delete would no longer know to remove the worktree.
  const cb = w.copyBranch;
  if (
    cb &&
    typeof cb === "object" &&
    typeof cb.repoCwd === "string" &&
    typeof cb.branch === "string" &&
    typeof cb.baseBranch === "string" &&
    typeof cb.city === "string" &&
    typeof cb.createdAt === "string"
  ) {
    normalized.copyBranch = {
      repoCwd: cb.repoCwd,
      branch: cb.branch,
      baseBranch: cb.baseBranch,
      city: cb.city,
      createdAt: cb.createdAt,
    };
  }
  return normalized;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck:node`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/storage.ts
git commit -m "Preserve Workspace.copyBranch through storage normalize"
```

---

## Task 5: Normalize the per-repo setup-command preference

**Files:**
- Modify: `src/main/preferences-store.ts` (`normalize()` ~line 145-179)

- [ ] **Step 1: Add a normalizer and wire it into `normalize()`**

In `src/main/preferences-store.ts`, add this helper function above `normalize` (before line 145):

```ts
// Validate the per-repo copy-branch setup-command map: string keys → non-empty
// string values. Anything malformed is dropped so a hand-edited prefs file
// cannot inject non-strings.
function normalizeCopyBranchSetupCommands(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [repo, cmd] of Object.entries(value as Record<string, unknown>)) {
    if (typeof repo === "string" && repo.trim() && typeof cmd === "string" && cmd.trim()) {
      out[repo] = cmd;
    }
  }
  return out;
}
```

In the object returned by `normalize()` (line 157-178), add a field before the closing brace (after `notificationChannels`):

```ts
    copyBranchSetupCommandByRepo: normalizeCopyBranchSetupCommands(
      src.copyBranchSetupCommandByRepo,
    ),
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck:node`
Expected: PASS — `normalize()` now returns a complete `AppPreferences` including the new field.

- [ ] **Step 3: Commit**

```bash
git add src/main/preferences-store.ts
git commit -m "Normalize per-repo copyBranchSetupCommandByRepo preference"
```

---

## Task 6: Copy-branch dialogs (delete confirm + error toast)

**Files:**
- Create: `src/renderer/src/components/CopyBranchDialogs.tsx`

- [ ] **Step 1: Create the component file**

Create `src/renderer/src/components/CopyBranchDialogs.tsx`:

```tsx
import { useEffect, useState } from "react";

// Two small surfaces for the copy-branch workspace flow:
//  - CopyBranchDeleteDialog: confirm removing a worktree-backed workspace,
//    with an opt-in to also delete its branch.
//  - CopyBranchErrorToast: a transient danger card for create/delete failures
//    (the app has no generic renderer-side toast push; notifications only flow
//    from the main process).

export function CopyBranchDeleteDialog({
  workspaceName,
  branch,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  workspaceName: string;
  branch: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (opts: { deleteBranch: boolean; force: boolean }) => void;
}) {
  const [deleteBranch, setDeleteBranch] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  // git worktree remove refuses a dirty tree; surface a force retry then.
  const dirty = Boolean(error && /contains modified or untracked|use --force/i.test(error));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Delete workspace ${workspaceName}`}
      style={{
        position: "absolute",
        inset: 0,
        background: "color-mix(in oklch, var(--bg) 70%, transparent)",
        display: "grid",
        placeItems: "center",
        zIndex: 1200,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        style={{
          width: "min(420px, calc(100vw - 48px))",
          background: "var(--panel-2)",
          border: "1px solid var(--rule)",
          borderRadius: 10,
          boxShadow: "var(--shadow-2)",
          padding: 18,
          fontFamily: "var(--font-sans)",
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>
          Delete “{workspaceName}”?
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.5 }}>
          This removes the git worktree from disk. The branch{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>{branch}</code> is kept
          unless you choose to delete it.
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--ink)",
            cursor: busy ? "not-allowed" : "default",
          }}
        >
          <input
            type="checkbox"
            checked={deleteBranch}
            disabled={busy}
            onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
          />
          Also delete the branch (only if already merged)
        </label>
        {error && (
          <div
            style={{
              fontSize: 12,
              color: "var(--danger)",
              background: "color-mix(in oklch, var(--danger) 12%, transparent)",
              border: "1px solid color-mix(in oklch, var(--danger) 40%, var(--rule))",
              borderRadius: 6,
              padding: "8px 10px",
              overflowWrap: "anywhere",
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <DialogButton label="Cancel" onClick={onCancel} disabled={busy} />
          {dirty && (
            <DialogButton
              label={busy ? "Removing…" : "Force remove"}
              danger
              disabled={busy}
              onClick={() => onConfirm({ deleteBranch, force: true })}
            />
          )}
          {!dirty && (
            <DialogButton
              label={busy ? "Removing…" : "Delete"}
              danger
              disabled={busy}
              onClick={() => onConfirm({ deleteBranch, force: false })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DialogButton({
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: "none",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        padding: "7px 14px",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "default",
        opacity: disabled ? 0.55 : 1,
        color: danger ? "var(--danger)" : "var(--ink)",
        background: danger
          ? "color-mix(in oklch, var(--danger) 14%, transparent)"
          : "transparent",
        border: `1px solid ${
          danger
            ? "color-mix(in oklch, var(--danger) 50%, var(--rule))"
            : "var(--rule-strong)"
        }`,
      }}
    >
      {label}
    </button>
  );
}

export function CopyBranchErrorToast({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!message) return undefined;
    const id = window.setTimeout(onDismiss, 6_000);
    return () => window.clearTimeout(id);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div
      role="alert"
      className="spark-fade-in"
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        zIndex: 1100,
        maxWidth: "min(380px, calc(100vw - 32px))",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid color-mix(in oklch, var(--danger) 60%, var(--rule-strong))",
        background: "color-mix(in oklch, var(--danger) 14%, var(--panel))",
        boxShadow: "var(--shadow-2)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", marginBottom: 2 }}>
          Copy branch failed
        </div>
        <div
          style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.4, overflowWrap: "anywhere" }}
        >
          {message}
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          color: "var(--muted)",
          cursor: "default",
          fontSize: 16,
          lineHeight: 1,
          padding: 4,
        }}
      >
        ×
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/CopyBranchDialogs.tsx
git commit -m "Add CopyBranchDeleteDialog + CopyBranchErrorToast components"
```

---

## Task 7: WorkspaceRail `⋯` popover menu

**Files:**
- Modify: `src/renderer/src/components/WorkspaceRail.tsx` (RailProps ~line 37; row render ~line 225; RowProps ~line 578; WorkspaceRow `⋯` button ~line 876)

- [ ] **Step 1: Add `onCreateCopyBranch` to `RailProps`**

In the `RailProps` interface (around line 54, near `onDelete`), add:

```ts
  onCreateCopyBranch: (id: string) => void;
```

- [ ] **Step 2: Pass the new row callbacks where `WorkspaceRow` is rendered**

In `renderSection`, the `<WorkspaceRow … />` element (starts ~line 225) currently wires `onActivate`, `onEdit`, etc. Add two props to it:

```tsx
                      onCreateCopyBranch={() => props.onCreateCopyBranch(w.id)}
                      onDelete={() => props.onDelete(w.id)}
```

- [ ] **Step 3: Add the two callbacks to `RowProps`**

In the `RowProps` interface (around line 578), add:

```ts
  onCreateCopyBranch: () => void;
  onDelete: () => void;
```

And destructure them in the `WorkspaceRow({ … })` parameter list (around line 594), adding `onCreateCopyBranch,` and `onDelete,`.

- [ ] **Step 4: Add menu state + outside-click handling in `WorkspaceRow`**

Inside `WorkspaceRow`, next to the existing `const [moreHover, setMoreHover] = useState(false);` (line 614), add:

```tsx
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
```

After the existing editing outside-click effect (ends ~line 703), add a parallel effect for the menu:

```tsx
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuWrapRef.current && e.target instanceof Node && !menuWrapRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
```

- [ ] **Step 5: Convert the `⋯` button into a menu trigger + popover**

Find the trailing `<button …>` that renders the `⋯` / checkmark glyph (starts ~line 876 with `onClick={(e) => { e.stopPropagation(); if (editing) { commitName(); onCloseEditor(); } else { onEdit(); } }}`). Replace that entire `<button>…</button>` element with this wrapper (keeps the editing → "Done" behaviour, but a non-editing click opens the menu instead of calling `onEdit` directly):

```tsx
        <div ref={menuWrapRef} style={{ position: "relative", flex: "0 0 18px" }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (editing) {
                commitName();
                onCloseEditor();
              } else {
                setMenuOpen((o) => !o);
              }
            }}
            onMouseEnter={() => setMoreHover(true)}
            onMouseLeave={() => setMoreHover(false)}
            title={editing ? "Done" : "Workspace actions"}
            style={{
              appearance: "none",
              background: "transparent",
              border: "none",
              borderRadius: 5,
              color: editing
                ? accent
                : menuOpen || moreHover || active
                  ? "var(--ink-dim)"
                  : "var(--muted-2)",
              width: 18,
              height: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "default",
              padding: 0,
              opacity: menuOpen || moreHover || active || editing ? 1 : 0.72,
              transition:
                "color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
            }}
          >
            {editing ? (
              <svg
                width="11"
                height="11"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="square"
              >
                <polyline points="1.5,5.5 4,8 8.5,2.5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
                <circle cx="2" cy="5" r="1" />
                <circle cx="5" cy="5" r="1" />
                <circle cx="8" cy="5" r="1" />
              </svg>
            )}
          </button>
          {menuOpen && !editing && (
            <div
              role="menu"
              style={{
                position: "absolute",
                top: 24,
                right: 0,
                minWidth: 168,
                background: "var(--panel-2)",
                border: "1px solid var(--rule)",
                borderRadius: 7,
                boxShadow: "var(--shadow-2)",
                padding: 4,
                zIndex: 20,
                display: "grid",
                gap: 2,
              }}
            >
              <RowMenuItem
                label="Edit"
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
              />
              <RowMenuItem
                label="Create copy branch"
                onClick={() => {
                  setMenuOpen(false);
                  onCreateCopyBranch();
                }}
              />
              <RowMenuItem
                label="Delete"
                danger
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              />
            </div>
          )}
        </div>
```

- [ ] **Step 6: Add the `RowMenuItem` helper**

Near the other small helpers at the bottom of the file (e.g. after `normalizeHex`, before `export { WORKSPACE_COLORS };`), add:

```tsx
function RowMenuItem({
  label,
  onClick,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        textAlign: "left",
        width: "100%",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 500,
        padding: "6px 9px",
        borderRadius: 5,
        border: "none",
        cursor: "default",
        color: danger ? "var(--danger)" : "var(--ink)",
        background: hover
          ? danger
            ? "var(--danger-soft)"
            : "var(--hover)"
          : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 7: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: FAIL — `onCreateCopyBranch` is now a required `RailProps` field but `App.tsx` does not pass it yet. This is expected and fixed in Task 8. (If you want a clean intermediate state, you may temporarily make it optional, but Task 8 adds the prop so leaving it required is fine.)

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/WorkspaceRail.tsx
git commit -m "Promote workspace row dots to a popover menu (Edit / Create copy branch / Delete)"
```

---

## Task 8: App wiring — create flow, worktree-aware delete, render dialogs

**Files:**
- Modify: `src/renderer/src/App.tsx` (imports; `deleteWs` ~line 1035; after `createWs` ~line 1074; both `<WorkspaceRail>` blocks ~line 2008/2107; render area near `<ToastHost/>` ~line 2171)

- [ ] **Step 1: Add imports**

Near the other component/type imports at the top of `App.tsx`, add:

```ts
import { CopyBranchDeleteDialog, CopyBranchErrorToast } from "./components/CopyBranchDialogs";
import { DEFAULT_COPY_BRANCH_SETUP_COMMAND } from "@shared/types";
```

(`makeId`, `basename`, `Workspace`, `WORKSPACE_COLORS` are already imported.)

- [ ] **Step 2: Add state for the create error and the delete dialog**

Next to the other `useState` hooks near the top of the `App` component (e.g. after `const [workspaces, setWorkspaces] = useState<Workspace[]>([]);` at line 177), add:

```tsx
  const [copyBranchError, setCopyBranchError] = useState<string | null>(null);
  const [pendingCopyDelete, setPendingCopyDelete] = useState<Workspace | null>(null);
  const [copyDeleteBusy, setCopyDeleteBusy] = useState(false);
  const [copyDeleteError, setCopyDeleteError] = useState<string | null>(null);
```

- [ ] **Step 3: Extract the workspace-removal core and make `deleteWs` worktree-aware**

Find `deleteWs` (line 1035-1056):

```tsx
  const deleteWs = useCallback((id: string) => {
    delete activeRunIdsByWorkspaceRef.current[id];
    if (activeIdRef.current === id) {
      disposeTerminalPanesInTabs(tabsRef.current.tabs);
    } else {
      disposePersistedWorkspaceTerminalPanes(id);
    }
    setWorkspaces((ws) => {
      const next = ws.filter((w) => w.id !== id);
      // dispose pty for any workers in deleted workspace
      const removed = ws.find((w) => w.id === id);
      if (removed) {
        for (const worker of removed.workers) {
          void window.spark.pty.dispose(worker.id);
        }
      }
      // Adjust active
      setActiveId((prev) => (prev === id ? next[0]?.id ?? null : prev));
      return next;
    });
    setEditingId(null);
  }, []);
```

Replace with (splits the removal into a reusable `removeWorkspaceFromState`, and routes copy-branch workspaces through the confirm dialog):

```tsx
  const removeWorkspaceFromState = useCallback((id: string) => {
    delete activeRunIdsByWorkspaceRef.current[id];
    if (activeIdRef.current === id) {
      disposeTerminalPanesInTabs(tabsRef.current.tabs);
    } else {
      disposePersistedWorkspaceTerminalPanes(id);
    }
    setWorkspaces((ws) => {
      const next = ws.filter((w) => w.id !== id);
      const removed = ws.find((w) => w.id === id);
      if (removed) {
        for (const worker of removed.workers) {
          void window.spark.pty.dispose(worker.id);
        }
      }
      setActiveId((prev) => (prev === id ? next[0]?.id ?? null : prev));
      return next;
    });
    setEditingId(null);
  }, []);

  const deleteWs = useCallback(
    (id: string) => {
      const target = workspaces.find((w) => w.id === id);
      // Copy-branch workspaces own a worktree on disk — confirm + remove it
      // rather than orphaning the directory.
      if (target?.copyBranch) {
        setCopyDeleteError(null);
        setPendingCopyDelete(target);
        return;
      }
      removeWorkspaceFromState(id);
    },
    [workspaces, removeWorkspaceFromState],
  );
```

- [ ] **Step 4: Add the create-copy-branch handler**

Immediately after `createWs` (ends line 1074), add:

```tsx
  const createCopyBranchWs = useCallback(
    async (sourceWs: Workspace) => {
      const res = await window.spark.git.createCopyWorktree(sourceWs.cwd);
      if (!res.ok) {
        setCopyBranchError(res.error);
        return;
      }
      setWorkspaces((list) => {
        const usedColors = new Set(list.map((w) => w.color.toLowerCase()));
        const color =
          WORKSPACE_COLORS.find((c) => !usedColors.has(c.toLowerCase())) ?? WORKSPACE_COLORS[0];
        const ws: Workspace = {
          id: makeId("ws"),
          name: res.city,
          cwd: res.path,
          color,
          workers: [],
          copyBranch: {
            repoCwd: sourceWs.cwd,
            branch: res.branch,
            baseBranch: res.baseBranch,
            city: res.city,
            createdAt: new Date().toISOString(),
          },
        };
        activeRunIdsByWorkspaceRef.current[ws.id] = null;
        setActiveId(ws.id);
        // Run the per-repo setup command live in a terminal in the new worktree.
        void window.spark.preferences.load().then((prefs) => {
          const cmd = (
            prefs.copyBranchSetupCommandByRepo?.[sourceWs.cwd] ??
            DEFAULT_COPY_BRANCH_SETUP_COMMAND
          ).trim();
          if (cmd) tabs.newTerminalTab(res.path, cmd);
        });
        return [...list, ws];
      });
    },
    [tabs],
  );

  const handleCreateCopyBranch = useCallback(
    (id: string) => {
      const ws = workspaces.find((w) => w.id === id);
      if (ws) void createCopyBranchWs(ws);
    },
    [workspaces, createCopyBranchWs],
  );

  const confirmCopyDelete = useCallback(
    async (opts: { deleteBranch: boolean; force: boolean }) => {
      const target = pendingCopyDelete;
      if (!target?.copyBranch) return;
      setCopyDeleteBusy(true);
      setCopyDeleteError(null);
      const result = await window.spark.git.removeCopyWorktree({
        repoCwd: target.copyBranch.repoCwd,
        worktreePath: target.cwd,
        branch: target.copyBranch.branch,
        force: opts.force,
        deleteBranch: opts.deleteBranch,
      });
      setCopyDeleteBusy(false);
      if (!result.ok) {
        setCopyDeleteError(result.error);
        return;
      }
      removeWorkspaceFromState(target.id);
      setPendingCopyDelete(null);
    },
    [pendingCopyDelete, removeWorkspaceFromState],
  );
```

- [ ] **Step 5: Pass `onCreateCopyBranch` to both `<WorkspaceRail>` instances**

In each `<WorkspaceRail … />` block (left ~line 1988, right ~line 2087), add next to `onCreate={createWs}`:

```tsx
            onCreateCopyBranch={handleCreateCopyBranch}
```

- [ ] **Step 6: Render the dialogs**

Find `<ToastHost onSelectRun={handleSelectRun} />` (line 2171) and add immediately after it:

```tsx
        <CopyBranchErrorToast
          message={copyBranchError}
          onDismiss={() => setCopyBranchError(null)}
        />
        {pendingCopyDelete?.copyBranch && (
          <CopyBranchDeleteDialog
            workspaceName={pendingCopyDelete.name}
            branch={pendingCopyDelete.copyBranch.branch}
            busy={copyDeleteBusy}
            error={copyDeleteError}
            onCancel={() => {
              if (!copyDeleteBusy) {
                setPendingCopyDelete(null);
                setCopyDeleteError(null);
              }
            }}
            onConfirm={confirmCopyDelete}
          />
        )}
```

- [ ] **Step 7: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (Task 7's missing-prop error is now resolved).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "Wire copy-branch create flow + worktree-aware delete in App"
```

---

## Task 9: Per-repo setup command in Settings → General

**Files:**
- Modify: `src/renderer/src/App.tsx` (the `<SettingsDialog>` block ~line 2126)
- Modify: `src/renderer/src/components/SettingsDialog.tsx` (props/destructure ~line 63; general tab render line 224; `GeneralSettings` ~line 681)

- [ ] **Step 1: Pass `workspaceCwd` from App into Settings**

In `App.tsx`, find the `<SettingsDialog>` block (line 2126) and add the prop:

```tsx
            workspaceCwd={activeWorkspace?.cwd ?? null}
```

- [ ] **Step 2: Thread `workspaceCwd` into `GeneralSettings`**

In `SettingsDialog.tsx`, add `workspaceCwd` to the top-level destructure (line 63-71):

```tsx
export default function SettingsDialog({
  settings,
  shells,
  defaultShell,
  workspaceCwd,
  initialTab = "general",
  onClose,
  onSave,
  onOpenRun,
}: SettingsDialogProps) {
```

Change line 224 from:

```tsx
            {activeTab === "general" && <GeneralSettings />}
```

to:

```tsx
            {activeTab === "general" && <GeneralSettings workspaceCwd={workspaceCwd} />}
```

- [ ] **Step 3: Accept the prop in `GeneralSettings` and render the field**

Change the `GeneralSettings` signature (line 681) from `function GeneralSettings() {` to:

```tsx
function GeneralSettings({ workspaceCwd }: { workspaceCwd?: string | null }) {
```

Inside `GeneralSettings`'s returned JSX, add this as the last child of its top-level container element (the outer `<div>` that wraps the section's rows), just before that container's closing `</div>`:

```tsx
      {workspaceCwd ? <CopyBranchSetupField workspaceCwd={workspaceCwd} /> : null}
```

- [ ] **Step 4: Add the `CopyBranchSetupField` component**

In `SettingsDialog.tsx`, add this component near the other section helpers (e.g. directly after the `GeneralSettings` function). It is self-contained: it calls `usePreferences()` itself and reuses the file's existing `SectionTitle` and `Label` helpers. Ensure `DEFAULT_COPY_BRANCH_SETUP_COMMAND` is added to the existing `@shared/types` import at the top of the file:

```tsx
function CopyBranchSetupField({ workspaceCwd }: { workspaceCwd: string }) {
  const { preferences, hydrated, setPreference } = usePreferences();
  const stored = preferences.copyBranchSetupCommandByRepo?.[workspaceCwd];
  const [text, setText] = useState<string>(stored ?? DEFAULT_COPY_BRANCH_SETUP_COMMAND);

  useEffect(() => {
    setText(
      preferences.copyBranchSetupCommandByRepo?.[workspaceCwd] ??
        DEFAULT_COPY_BRANCH_SETUP_COMMAND,
    );
  }, [workspaceCwd, preferences.copyBranchSetupCommandByRepo]);

  if (!hydrated) return null;

  const commit = () => {
    const trimmed = text.trim();
    const next = { ...(preferences.copyBranchSetupCommandByRepo ?? {}) };
    // Store only meaningful overrides; the default is implicit.
    if (!trimmed || trimmed === DEFAULT_COPY_BRANCH_SETUP_COMMAND) {
      delete next[workspaceCwd];
    } else {
      next[workspaceCwd] = trimmed;
    }
    void setPreference("copyBranchSetupCommandByRepo", next);
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          height: 1,
          background: "var(--rule-soft)",
          margin: "2px 0",
        }}
      />
      <SectionTitle
        title="Copy-branch workspaces"
        detail="Command run in a terminal in a new copy-branch worktree, to restore deps git doesn't track. Saved for this repo."
      />
      <Label text="Setup command">
        <input
          type="text"
          value={text}
          spellCheck={false}
          placeholder={DEFAULT_COPY_BRANCH_SETUP_COMMAND}
          onChange={(e) => setText(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              e.currentTarget.blur();
            }
          }}
          style={{
            appearance: "none",
            width: "100%",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--ink)",
            background: "var(--panel)",
            border: "1px solid var(--rule)",
            borderRadius: 6,
            padding: "7px 9px",
            outline: "none",
          }}
        />
      </Label>
    </div>
  );
}
```

Note: `SectionTitle`, `Label`, `usePreferences`, `useState`, and `useEffect` are all already imported/defined in `SettingsDialog.tsx` (used by `EditorSettings`). Only `DEFAULT_COPY_BRANCH_SETUP_COMMAND` is a new import.

- [ ] **Step 5: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/SettingsDialog.tsx
git commit -m "Add per-repo copy-branch setup command field to Settings → General"
```

---

## Task 10: Full verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: PASS (node + web + e2e configs).

- [ ] **Step 2: Worktree module test**

Run: `npm run test:worktrees`
Expected: `PASS: git-worktrees`, exit 0.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: completes with no errors (main/preload/renderer bundles emitted to `out/`).

- [ ] **Step 4: Manual smoke (run the app)**

Run: `npm run dev`

Verify, in order:
1. Open a workspace pointing at a real git repo. Click its `⋯` → the popover shows **Edit / Create copy branch / Delete**.
2. Click **Create copy branch**. A new workspace appears named after a city, becomes active, and a terminal opens running `npm install` (or the repo's configured command) in the new worktree.
3. Confirm on disk: `ls ~/.SparkAgent/worktrees/<repo>/<city>` shows the tree; `git -C <that path> rev-parse --abbrev-ref HEAD` prints the city branch.
4. In the new workspace, open **Source Control**: it shows the city branch as current on a clean tree; staging/committing a change works. (Smart Merge will report "no upstream" until first push — expected.)
5. In the original repo workspace, open the branch menu: the city branch is listed and **Merge `<city>` into `<current>`** is available.
6. Settings → General shows the **Copy-branch workspaces** setup-command field; editing it persists (reopen Settings to confirm) and the next create uses it.
7. Delete the copy-branch workspace via `⋯` → **Delete**: the confirm dialog appears; confirm with "also delete branch" checked. The workspace disappears, `~/.SparkAgent/worktrees/<repo>/<city>` is gone, and the branch no longer appears in the source repo's branch list.
8. Delete a *normal* (non-copy) workspace: it is removed immediately with no dialog (unchanged behaviour).

- [ ] **Step 5: Final commit (if any smoke fixes were needed)**

```bash
git add -A
git commit -m "Copy-branch workspaces: verification fixes"
```

---

## Notes for the implementer

- **Why no TDD for the renderer tasks:** the repo has no unit-test runner; the type system + the manual smoke are the verification. Only `git-worktrees.ts` is isolated-testable, and Task 2 does it test-first.
- **Worktree location** is `~/.SparkAgent/worktrees/<repo-basename>/<city>/` (computed in `ipc.ts` from `sparkHome()`), keeping Spark's worktrees separate from Conductor's `~/conductor/...`.
- **No "Merge to main" UI** — merge-back is the existing branch-menu "Merge into current" (`BranchMenu.tsx`). Do not add a merge button.
- **No upstream on fresh branches** is intentional; do not auto-set one. Smart Merge correctly reports its absence until the user pushes.
- Keep diffs minimal and follow existing styling tokens (`--panel-2`, `--rule`, `--motion-fast`, etc.). Honour `prefers-reduced-motion` (the components above use no entrance animation beyond the existing `spark-fade-in`).
