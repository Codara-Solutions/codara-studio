# Copy-branch workspaces — design

- **Date:** 2026-06-02
- **Status:** Approved (ready for implementation plan)
- **Branch:** `spark-changes-test`

## Context

[Conductor](https://www.conductor.build/docs) gives every new workspace an
isolated **git worktree** on its own branch, named after a random city, branched
from the project's default branch. The city name is the durable directory name;
the working tree is fully separate so parallel agents never collide. A
post-create **setup script** restores the things git does not track
(`node_modules`, `.env`). This machine already runs Conductor on this repo — its
worktrees live under `~/conductor/workspaces/spark-agent-main/<city>/` (calgary,
munich, tunis).

We want the same "spin up an isolated copy of main in one click" capability
inside Spark itself, but as an **explicit action**, not as the behaviour of the
`+` button. The `+` keeps meaning "open any folder as a workspace."

## Goals

- One-click creation of a workspace that is a git worktree on a fresh
  city-named branch off `main`, with deps installed and ready to run.
- The new worktree is a first-class git workspace: Source Control reflects it
  and all git actions work inside it.
- Clean teardown: deleting a copy-branch workspace removes its worktree (and
  optionally its branch) instead of leaving orphans on disk.

## Non-goals (deferred)

- Conductor's **run-script + `CONDUCTOR_PORT`** system. Heaviest, most
  opinionated piece; overlaps Spark's existing terminal/preview tooling, and
  running two Electron dev instances has its own quirks. Worst ROI for v1.
- A dedicated "Merge to main" action. Merge-back already exists in the Source
  Control branch menu (see "Source Control integration").
- "Branch checked out elsewhere" markers in the branch list (polish).
- Per-workspace setup overrides beyond the per-repo default.

## Locked decisions

| Decision | Choice |
|---|---|
| Worktree backing | git worktree (not full clone) |
| Worktree location | `~/.SparkAgent/worktrees/<repo-basename>/<city>/` |
| Base branch | **remote default `origin/main`** (Conductor-faithful — "Branched from origin/main"), falling back to local main → master → current HEAD when there is no remote |
| Create flow | one-click, random city, no dialog |
| Naming | city slug is both the directory name and the branch name in v1 |
| Setup step | per-repo configurable command, **default empty (opt-in)** — nothing auto-runs (matches Conductor's optional setup script); set e.g. `pnpm install` per-repo where wanted |
| Row appearance | copy-branch rows **inherit the parent workspace's color**, show a **branch glyph** (not the color dot), and are **indented + inserted directly under their parent** so they read as a branch of it |
| Delete behaviour | confirm dialog each time: remove worktree (✓), optionally delete branch (☐, safe `-d`) |
| Merge-back | via the existing Source Control branch menu (no new button) |
| Menu home | the per-row `⋯` button, promoted to a popover |

> **Revision (2026-06-02, post-first-run):** base changed from local `main` → `origin/main`; setup default changed from `npm install` → empty (opt-in); copy-branch rows now inherit parent color + branch glyph + indent. Rationale: testing on multi-repo workspaces where `main` is a stale baseline and repos use pnpm / have no root `package.json` showed `npm install` as a default produced spurious errors, and a distinct color/icon/indent makes the parent→branch relationship legible (per Conductor's UI).

## Architecture

Follow the existing grain: **`git-*.ts` modules are dumb, `cwd`-keyed
primitives** exposed as `git:*` IPC channels, and **`App.tsx` owns the Workspace
lifecycle** (e.g. `createWs` at `App.tsx:1058`).

- **Main** owns a new `git-worktrees.ts` (git + naming + path + `sparkHome()`
  access) exposed via `git:*` channels.
- **Renderer** (`App.tsx`) owns the flow: call the primitive → register a
  `Workspace` → spawn the setup terminal via the existing
  `tabs.newTerminalTab(cwd, autorun)` (`App.tsx:1276`) → activate.

Rejected alternative: a single fat `workspace:createCopyBranch` main-process
channel that does everything. Main cannot spawn Spark terminal tabs (renderer
only), and it would break the "git modules are primitives" convention.

## Data model

`src/shared/types.ts` — add optional provenance to `Workspace`. Its **presence**
marks a workspace as a copy-branch (drives worktree-aware delete):

```ts
export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  color: string;
  workers: Worker[];
  copyBranch?: {
    repoCwd: string;     // source repo the worktree was forked from
    branch: string;      // branch checked out here (== city in v1)
    baseBranch: string;  // what it forked from, e.g. "main"
    city: string;        // generated slug
    createdAt: string;   // ISO timestamp
  };
}
```

`src/main/storage.ts` — **`normalize()` (line 72) rebuilds each Workspace from a
fixed field set, so a new field is silently dropped on save unless added here.**
Add `copyBranch` passthrough with shape validation (object with five string
fields, else omit). This is the single easiest-to-miss correctness wire.

## Main module: `src/main/git-worktrees.ts` (new)

All functions `runGit`-based; mutations return the existing `GitOpResult`
(`{ ok: true } | { ok: false; error }`). Keep exported signatures stable —
`ipc.ts` wires to them.

```ts
// Resolve the repo's default branch:
//   origin/HEAD target → local "main" → local "master" → current branch.
resolveDefaultBranch(repoCwd: string): Promise<string>

// Pick an unused city slug for this repo. Source = a bundled list (~200
// lowercase, hyphenated city slugs, const in this file). Exclude any city
// already used as a local branch name OR as an existing worktree directory for
// this repo. If the chosen city collides, suffix "-2", "-3", …
pickCity(repoCwd: string): Promise<string>

// Create the worktree. Resolves base if omitted, picks city if omitted,
// computes path = join(sparkHome(), "worktrees", basename(repoCwd), city),
// runs: git worktree add <path> -b <city> <baseBranch>
createCopyWorktree(input: {
  repoCwd: string;
  baseBranch?: string;
  city?: string;
}): Promise<
  | { ok: true; path: string; branch: string; city: string; baseBranch: string }
  | { ok: false; error: string }
>

// Remove the worktree dir + prune metadata; optional safe branch delete.
//   git worktree remove [--force] <path>
//   git worktree prune
//   (deleteBranch) git branch -d <branch>   // surfaces unmerged error
removeCopyWorktree(input: {
  repoCwd: string;
  worktreePath: string;
  branch: string;
  force?: boolean;
  deleteBranch?: boolean;
}): Promise<GitOpResult>
```

City list lives inline in this module as a plain `const CITY_SLUGS: string[]`.
No external dependency.

## IPC + preload

Mirror the existing `git:createBranch` pattern exactly.

- `src/main/ipc.ts`: register `git:createCopyWorktree` and
  `git:removeCopyWorktree`, each delegating to the module function. Invalidate
  the git cache for `repoCwd` after a successful create/remove so the source
  repo's branch list refreshes.
- `src/preload/index.ts`: add `createCopyWorktree(input)` and
  `removeCopyWorktree(input)` under the existing `git:` block.

## Preferences: per-repo setup command

`src/shared/types.ts` — add to `AppPreferences` and `DEFAULT_PREFERENCES`:

```ts
// keyed by absolute repo cwd → setup command string
copyBranchSetupCommandByRepo: Record<string, string>; // default {}
```

Plus an exported `DEFAULT_COPY_BRANCH_SETUP_COMMAND = "npm install"`.

`src/main/preferences-store.ts` — add a `normalizeCopyBranchSetupCommandByRepo`
(string keys → non-empty string values; drop anything else) and wire it into
`normalize()` (line 145). Reads/writes use the existing `loadPreferences` /
`setPreference<K>` / `getPreferenceSync<K>` plumbing — no new IPC shape.

Resolution at create time (renderer):
`prefs.copyBranchSetupCommandByRepo[repoCwd] ?? DEFAULT_COPY_BRANCH_SETUP_COMMAND`.

`SettingsDialog.tsx` — a "Copy-branch setup command" field bound to the **active
workspace's repo** (the `copyBranch.repoCwd` if it is a copy-branch workspace,
otherwise its own `cwd`). Editing it writes that repo's entry in the map.

## Renderer flow (`App.tsx`)

**`createCopyBranchWs(sourceWs: Workspace)`** — new `useCallback`:

1. Guard: `sourceWs.cwd` must be a git repo (reuse a status/`isRepo` check). If
   not, toast and bail.
2. `const r = await window.spark.git.createCopyWorktree({ repoCwd: sourceWs.cwd })`.
   On `!r.ok`, toast `r.error`.
3. Build the `Workspace`: `id = makeId("ws")`, `name = r.city`,
   `cwd = r.path`, `color =` next unused workspace color (reuse the
   `WORKSPACE_COLORS` logic from `createWs`), `workers: []`,
   `copyBranch = { repoCwd: sourceWs.cwd, branch: r.branch, baseBranch: r.baseBranch, city: r.city, createdAt: <iso> }`.
4. `setWorkspaces([...list, ws])`; set active; (do **not** open inline rename —
   unlike `createWs`, the city name is the intended name).
5. Resolve the setup command for `sourceWs.cwd`; if non-empty,
   `tabs.newTerminalTab(r.path, setupCommand)` so it runs live in a terminal in
   the new worktree.

**Delete** — when the workspace being deleted has `copyBranch`, intercept the
existing delete path (`onDelete` → `deleteActiveWorkspace`) to show a confirm
dialog:

```
Delete '<name>'?
  [✓] remove worktree
  [ ] also delete branch (if merged)
  [ Cancel ] [ Delete ]
```

On confirm: `await window.spark.git.removeCopyWorktree({ repoCwd, worktreePath: cwd, branch, deleteBranch })`,
then drop the workspace from state. If `git worktree remove` fails because the
tree is dirty, offer a "force remove" retry (`force: true`). Non-copy
workspaces keep today's behaviour untouched (no worktree call).

## UI: promote `⋯` to a popover menu

`WorkspaceRail.tsx` — the per-row `⋯` button (line 876) currently calls `onEdit`
directly. Convert it to a small popover (Spark `--panel-2` surface, existing
shadow/motion tokens, `prefers-reduced-motion` respected) with items:

- **Edit** → `onEdit()` (existing inline rename/recolor, unchanged)
- **Create copy branch** → new `onCreateCopyBranch(ws)`. Always shown enabled;
  the handler validates that `ws.cwd` is a git repo and toasts if not (the rail
  has no synchronous repo-status to gate on at render time)
- **Delete** → existing delete path (worktree-aware as above)

A new `RailProps` callback `onCreateCopyBranch(id)` threads from `App.tsx`
through `WorkspaceRail` to `WorkspaceRow`, alongside the existing
`onEdit`/`onDelete`. The popover closes on outside-click / Escape, matching the
inline-edit dismissal already in `WorkspaceRow`.

## Source Control integration (explicit requirement)

The created worktree must be a fully functional git workspace, verified not
assumed:

- Every git op is `cwd`-keyed and uses worktree-correct plumbing —
  `rev-parse --show-toplevel`, `--is-inside-work-tree`, `@{u}`
  (`git-ops.ts:128,555,597`). Nothing reads `.git` as a directory. So status,
  diff, commit, stage, stash, branch-switch, and Smart Merge all operate on the
  worktree's own branch.
- After create, the source repo's branch list and the new workspace's panel
  must reflect the new branch. The `git:createCopyWorktree` handler invalidates
  the git cache for `repoCwd`; the new workspace reads fresh on activation.
- **Merge-back already exists:** `BranchMenu.tsx:585` offers
  "Merge `<branch>` into `<current>`" via `git.mergeBranch`. From the original
  repo workspace (on `main`), the user merges the city branch in. No new action.
- **Smart Merge** (`git/smart-merge.ts`) is upstream→local ("bring my branch up
  to date with its upstream"), not branch→main. A freshly created branch has
  **no upstream** until the first `git push -u`, so Smart Merge will correctly
  report "no upstream configured" in a brand-new copy workspace. This is correct
  git behaviour, not a bug.

## Edge cases & error handling

- **Dirty source repo:** fine — the worktree forks the committed base; the
  parent's uncommitted changes stay in the parent.
- **City / branch / path collision:** `pickCity` excludes used branches and
  existing worktree dirs and suffixes on collision; if the computed path still
  exists, regenerate.
- **Base branch checked out elsewhere:** `worktree add -b <new>` is unaffected
  (only *checking out* an already-live branch is blocked by git).
- **Source repo moved/deleted:** orphans its worktrees (git limitation);
  `worktree prune` on the next remove mitigates. Documented, not handled.
- **`git worktree remove` on a dirty tree:** fails; offer force-remove retry.
- **No remote / `origin`:** default-branch resolver falls back to local
  `main`/`master`/current; create still works.

## Testing

The repo has **no unit runner** — only Playwright e2e, `tests/e2e/*.cjs`, and
`npm run typecheck`. Match that convention:

- **`scripts/test-worktrees.cjs`** (new): against a throwaway temp git repo in
  `os.tmpdir()` — `git init`, commit, then exercise the module via a tiny
  harness: create copy worktree → assert the worktree dir exists, the branch is
  checked out there, and `git -C <path> status` is clean on the city branch →
  remove (with `deleteBranch`) → assert the dir is gone and the branch is
  deleted. Pure git behaviour, no Electron.
- **`npm run typecheck`** must pass (new types, IPC signatures, preferences).
- Optional later: a Playwright path that opens the `⋯` menu and clicks
  "Create copy branch."

## File-by-file change list

| File | Change |
|---|---|
| `src/shared/types.ts` | `Workspace.copyBranch?`; `AppPreferences.copyBranchSetupCommandByRepo` + default; `DEFAULT_COPY_BRANCH_SETUP_COMMAND` |
| `src/main/git-worktrees.ts` *(new)* | `resolveDefaultBranch`, `pickCity`, `createCopyWorktree`, `removeCopyWorktree`, `CITY_SLUGS` |
| `src/main/ipc.ts` | `git:createCopyWorktree`, `git:removeCopyWorktree` (+ cache invalidation) |
| `src/preload/index.ts` | `git.createCopyWorktree`, `git.removeCopyWorktree` |
| `src/main/storage.ts` | preserve `copyBranch` in `normalize()` |
| `src/main/preferences-store.ts` | normalize + carry `copyBranchSetupCommandByRepo` |
| `src/renderer/src/App.tsx` | `createCopyBranchWs`; worktree-aware delete; pass `onCreateCopyBranch` to rail |
| `src/renderer/src/components/WorkspaceRail.tsx` | `⋯` popover menu; `onCreateCopyBranch` prop wiring |
| `src/renderer/src/components/SettingsDialog.tsx` | per-repo setup command field |
| `scripts/test-worktrees.cjs` *(new)* | temp-repo integration test |

## Rollout

Built and tested on `spark-changes-test`. The feature is additive and behind an
explicit action, so it does not change existing `+`/open-folder behaviour.
