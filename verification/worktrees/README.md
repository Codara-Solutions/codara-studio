# Model check: the worktree lifecycle

TLA+ models of Studio's worktrees from creation to removal, checked with TLC.
TLC tries every order of events within small limits (one or two worktree rows,
three commits, one crash) and either proves each rule holds or prints the
shortest sequence of events that breaks it.

Deleting work is the risk: Studio removes merged worktrees on its own (#123),
agents remove theirs with `codara_worktree_remove`, and the git history holds
about 44 worktree fixes. These models say which rules hold today, which do
not, and what change makes them hold.

They are not part of `npm test`. Run them when you change worktree create,
removal, cleanup or the recovery refs:

```sh
npm run verify:worktrees                                    # every config, about 6 min on 4 cores
verification/worktrees/check.sh WorktreeLifecycle_auto      # one config
TLC_CPUS=8 TLC_MEM=8g verification/worktrees/check.sh       # more room (memory in g)
```

The script runs TLC 1.7.4 (`tla2tools.jar`, checksum pinned, cached in
`~/.cache/codara-tla`) in `eclipse-temurin:21-jre` pinned by digest, with
`--cpus`, `-m` and `--network none`. It needs Docker. Each `.cfg` says on its
first line what TLC must answer: `pass`, the invariant it must break,
`deadlock` or `temporal`. The script fails when any answer differs, so a model
that stops catching a known bug fails as loudly as one that finds a new one.
Counterexamples land in `out/<config>.out` (not committed).

## What the specs model

| Spec | Code it follows | What it covers |
|---|---|---|
| [WorktreeLifecycle.tla](WorktreeLifecycle.tla) | `src/main/agent-worktrees.ts` (create, `verifyRemovable`, `proveMerged`, `removeAgentWorktree`, `removeLocked`), `src/main/worktree-cleanup/rail.ts` (modes `auto-merged` and `auto`), `remove.ts` (`removeOne`), `inspect.ts` (`checkRemoval`, `mergeFacts`, `usageOf`), `src/main/git-worktrees.ts` (`pickCheckoutDirName`, `removeCopyWorktree`), the renderer's held probe (`App.tsx`) | Rows, folders, git registrations, branches local and on GitHub, pull requests, the repository lock, the two removal paths step by step, and the world around them |
| [RecoveryWindow.tla](RecoveryWindow.tla) | `pruneRecoveryRefs` and `dateStamp` | How long `refs/codara/removed-worktrees/<day>/<id>` lives |

Actions in `WorktreeLifecycle.tla`:

- `A*`, the automatic removal of a merged worktree: `AScan` (the rail offers
  the row and the renderer does not hold it), `AEntry` (`cleanUpRailWorkspace`:
  not on screen, no other workspace inside, quiet), `ACheck` (unlocked
  `checkRemoval` plus `autoMergedRefusal`), `ALock`, `ARecheck` (the check
  again under the lock, same fingerprint), `ALast` (`lastMomentRefusal`),
  `ARef` (recovery ref), `AGit` (`git worktree remove` without force; with
  `partial`, git deletes some files, drops the registration and fails),
  `ABranch` (`deleteBranchIfAt`, then the lock is let go), `ARow` (the row
  goes). `AMissing` is mode `auto`: a row whose folder and registration are
  gone.
- `G*`, an agent's `codara_worktree_remove`, asked by the agent that made the
  worktree or by another: `GVerify` (unlocked, with fetch and process scan),
  `GLock`, `GRecheck` (pinned target, no process scan), `GRef` (the
  recovery ref, the next free suffix when the name holds another commit),
  `GGit` (on a failure the ref stays), `GBranch`, `GRow`. `GMissing` is the
  `alreadyRemoved` path: the folder is gone, and the branch goes if its tip
  is merged and saved in a recovery ref.
- The world: `Create` (a new branch from `origin/main`, or an existing branch
  checked out again), `Edit`, `Discard`, `Commit`, `Push`, `WriteIgnored`,
  `DropIgnored`, `Quiet` (30 minutes without git activity), terminals,
  processes and tabs opening and closing, `OwnerCloses` (the creating agent's
  pane), `SelfRemove` (an agent runs `git worktree remove` itself), GitHub
  (`OpenPr`, `MergePr` as squash or merge commit, `DeleteRemote`,
  `ForcePush`), `Fetch`, and `Crash` (Studio quits between any two steps:
  the in-memory lock and both removals are gone). With `reuse`, the branch
  already exists before the first worktree, so checking out an existing
  branch is reachable with one row.

Commits are numbers with parents and a content set, so a squash merge carries
a branch's content without its commits. A commit is safe when its content is
in `main` on GitHub or GitHub holds the commit (a branch, an open pull
request, a merged pull request's head).

Not modelled: worktrees that are not rows (Studio never removes those),
submodules, nested checkouts, locked worktrees, the ignored-file scan's
regenerable list (an ignored file here is one the scan would keep), the
2-minute uptime rule, the renderer's retry backoff, and real time (only the
order of events counts). The agent removal is proved against `main` on
GitHub; an explicit local `target` (`agent-worktrees.ts:2023`) is not
modelled, so with one the guarantee is weaker: the work is kept in that
local branch, not necessarily on GitHub. Paths are the branch's slug and slug-2, as
`pickCheckoutDirName` makes them.

### Actors

`Act` turns on the actors a config needs: `uses` (terminals, Cora runs, dev
servers), `proc` (a process only the process scan sees), `tabs` (tabs of the
worktree's own workspace), `ftab` (an editor tab of another workspace on a
file inside the worktree), `ignored`, `self`, `force`, `reuse`, `partial` (a
`git worktree remove` that fails halfway), `agentrm` (the agent removal runs),
`noauto` (the automatic removal never starts), `handle` (a process that had
the folder open before it was moved writes into it afterwards), and `late`: something touches the folder after a
removal's last check and before its delete. Since the folder is moved
aside before it is deleted, `late` can only act before the move; `handle`
is what still acts after it.

## Invariants

| Invariant | In plain words |
|---|---|
| `NoIgnoredLost` | Studio never deletes kept ignored files (a `.env`, notes, outputs) |
| `NeverRemovedInUse` | Studio never deletes a folder something uses: an agent's open pane (except the agent that asked), a tab, a terminal, a process |
| `NoUnsafeRemoved` | Studio never deletes a folder or branch whose last commit is not safe on GitHub |
| `RemovedReachable` | Every head Studio deleted stays reachable here (the recovery ref) |
| `NoCollateral` | Removing one row never deletes another row's folder |
| `OneCheckoutPerBranch` | Two folders never have the same branch checked out |
| `OneRowPerPath` | Two live rows never claim the same folder |
| `KeptForWindow` | A recovery ref is never pruned before it is 30 days old |
| `MergedIdleLeaves` (liveness) | A row that stays merged, clean, quiet and unused is removed |

## Configs

| Config | TLC must answer | What it shows |
|---|---|---|
| `WorktreeLifecycle_auto` | pass | Today's automatic removal, one row, every actor it is built to handle, `late` included, one crash |
| `WorktreeLifecycle_agent` | pass | Today's `codara_worktree_remove` beside it, tabs, stray processes, `late`, failing halfway and a folder already gone included |
| `WorktreeLifecycle_two_rows` | pass | Today, two rows on one branch: checked out again, force-pushed, failing halfway |
| `WorktreeLifecycle_reach` | NothingRemoved | Not vacuous: the automatic removal does remove a merged worktree |
| `WorktreeLifecycle_reach_agent` | NothingRemoved | Not vacuous: the agent removal does too, with the automatic one off |
| `WorktreeLifecycle_liveness` | pass | A merged, idle worktree leaves on its own |
| `WorktreeLifecycle_fixed` | pass | With the fixes still proposed (`paths`, `bind`), every rule holds with every actor on, `late` included (not `handle`) |
| `WorktreeLifecycle_fixed_two_rows` | pass | With the fixes still proposed, two rows never share a folder and no removal deletes another row's folder |
| `WorktreeLifecycle_finding_late_write` | pass | Finding 1, fixed: a late ignored file is seen once the folder is moved aside |
| `WorktreeLifecycle_finding_late_use` | pass | Finding 1, fixed: so is a late tab (the window #123 declined) |
| `WorktreeLifecycle_finding_agent_tabs` | pass | Finding 2, fixed: tabs hold a worktree against the agent removal |
| `WorktreeLifecycle_finding_foreign_tab` | pass | Finding 2, fixed: another workspace's tab on a file inside holds it against the automatic removal |
| `WorktreeLifecycle_finding_path_reuse` | NoCollateral | Finding 3, the agent removal |
| `WorktreeLifecycle_finding_auto_rebind` | NoCollateral | Finding 3, the automatic removal (with `paths` on, without `bind`) |
| `WorktreeLifecycle_finding_agent_process` | pass | Finding 4, fixed: the agent removal scans processes under the lock |
| `RecoveryWindow_finding_early_prune` | pass | Finding 5, fixed: a ref lives 30 full days, counted from the end of its day |
| `WorktreeLifecycle_finding_missing_ref` | pass | Finding 6, fixed |
| `WorktreeLifecycle_finding_partial_ref` | pass | Finding 7, fixed |
| `WorktreeLifecycle_limit_aside_handle` | NoIgnoredLost | The limit of finding 1's fix: a handle opened before the move still writes into the moved folder |
| `WorktreeLifecycle_bug_owner_pane` | NeverRemovedInUse | Puts back the bug fixed in 8f142d5b: another agent's removal deleted a fresh worktree its creator was still working in |
| `WorktreeLifecycle_bug_agent_tabs` | NeverRemovedInUse | Puts back finding 2 in the agent removal: it never asked the window about tabs |
| `WorktreeLifecycle_bug_foreign_tab` | NeverRemovedInUse | Puts back finding 2 in the automatic removal: the window answered for the worktree's own workspace only |
| `WorktreeLifecycle_bug_missing_ref` | RemovedReachable | Puts back finding 6: the folder-gone path ignored a failed ref save |
| `WorktreeLifecycle_bug_partial_ref` | RemovedReachable | Puts back finding 7: a removal that failed halfway deleted its own ref |
| `WorktreeLifecycle_bug_late_write` | NoIgnoredLost | Puts back finding 1: deleted in place, a late ignored file goes with the folder |
| `WorktreeLifecycle_bug_late_use` | NeverRemovedInUse | Puts back finding 1: a late tab |
| `WorktreeLifecycle_bug_agent_process` | NeverRemovedInUse | Puts back finding 4: no process scan under the lock |
| `RecoveryWindow_bug_early_prune` | KeptForWindow | Puts back finding 5: the age was counted from the stamped day's midnight |
| `WorktreeLifecycle_bug_own_branch_target` | NoUnsafeRemoved | Puts back the bug fixed in 49306a6f: the worktree's own branch named as the target made the ancestor proof hold for unmerged work |

A `finding` config fails today and passes once its fix lands: flip its first
line to `pass` in the same PR, and once a fix is in the code, model it as the
only behaviour and drop its `Fix` flag.

## Findings

Findings 1 to 4 are ranked by what can be lost; 5 to 7 break the promise
that a removed head stays recoverable for 30 days. A fix not in the code yet is a `Fix` flag that
`WorktreeLifecycle_fixed` turns on; a fix in the code is the
model's only behaviour, and a `Bug` flag puts the old code back.

1. **The last check and the delete were two steps** (`late`). Fixed in
   part: both removals take a fingerprint of what git would delete (HEAD,
   `git status` with untracked and ignored entries, the size and time of
   every file under them) before their last check, then move the folder
   aside with `git worktree move` (`removeCopyWorktree`,
   `git-worktrees.ts`), check it again there (the same fingerprint, and no
   terminal, run, tab or process under either name: `changedWhileAside` in
   `agent-worktrees.ts` and `remove.ts`), and put it back if anything
   changed. A folder left aside by a stopped Studio goes back under the lock
   before the next removal or cleanup in that repository, as the note
   Studio keeps in the repository's git folder for each move says
   (`restoreAsideWorktrees`); a folder Studio did not move is never touched. Before, git deleted ignored files without
   asking, so one written between the last check and `git worktree remove`
   (a `.env`, notes, test output) was lost, and a tab or terminal opened in
   that window was not seen (`WorktreeLifecycle_bug_late_write`,
   `_bug_late_use`). The limit stays: a process that already had the folder
   open (its working directory or a file handle) still writes into the
   moved folder after the last check (`WorktreeLifecycle_limit_aside_handle`).
   Closing it fully needs the ignored files copied aside before the delete,
   or every writer stopped. A folder of more than 500,000 entries is not
   removed: it is too large to compare. A folder that cannot be put back
   (something took its name, or its parent cannot be written) stays aside
   and blocks the removal and the cleanup until it can.
2. **Editor tabs did not hold a worktree everywhere** (`tabs`, `ftab`).
   Fixed: both removals ask the window, under the lock, one question for
   the folder: does the window show the worktree's workspace or hold tabs of
   it, or does a tab of any workspace show a file inside it
   (`verifyRemovable`, `lastMomentRefusal` in `rail.ts`, the probe in
   `App.tsx` and `tabs/tabsShowingPath.ts`). Before, the agent removal never
   asked the window (`verifyRemovable` counted terminals only), so a worktree
   whose workspace had an editor tab open (an unsaved buffer) could be
   removed by `codara_worktree_remove`; and the automatic removal asked about
   the worktree's own workspace only, so a file inside it opened from another
   workspace (an agent's `codara_open_file` lands in the agent's own
   workspace) did not hold it. `WorktreeLifecycle_bug_agent_tabs` and
   `WorktreeLifecycle_bug_foreign_tab` put each half back.
3. **A row left behind keeps its folder name for a new worktree**
   (`self`, two rows). `pickCheckoutDirName` (`git-worktrees.ts:219`) only
   avoids folders on disk. When an agent removed a worktree with plain
   `git worktree remove` (or Studio crashed between delete and row drop), its
   row stays until the rail's next poll; a new worktree on the same branch
   name then gets the same folder. The automatic removal refuses such a pair
   (`holdsOtherWorkspace`), but `codara_worktree_remove` on the old row
   passes: the registration's branch has the same name
   (`agent-worktrees.ts:1843`), its tip is the new worktree's, a fresh tip
   reads as merged, and only the old row's creator pane is checked
   (`agent-worktrees.ts:1798`). It deletes the new worktree while its agent
   works in it. Uncommitted work still blocks, so the loss is the new
   worktree itself. The automatic removal reads the rows once, at its start
   (`cleanUpRailWorkspace`), then checks and deletes by path: if the row is
   removed and a new worktree made in its folder between that read and
   `checkCleanupTargets`, the new one is judged and deleted instead
   (`WorktreeLifecycle_finding_auto_rebind`; the window is a few git calls,
   so very unlikely). Likelihood: low. Fix `paths`: skip any folder a live
   row names when picking one. Fix `bind`: in both locked re-checks, read the
   rows again and refuse unless the row asked for is still there and alone
   at its folder.
4. **The agent removal did not scan processes under the lock.** Fixed: the
   re-check in `removeLocked` scans processes (`scanProcesses: true`), and
   so does the check once the folder is aside. Before, a process started in
   the worktree while the removal waited for the lock (up to 60 s) was not
   seen (`WorktreeLifecycle_bug_agent_process`).
5. **Recovery refs lasted 29 days and some hours, not 30.** Fixed:
   `pruneRecoveryRefs` (`agent-worktrees.ts:2393`) counts the 30 days from
   the end of the UTC day the ref is named after. Before, it counted from
   that day's midnight, so a ref saved at 23:00 UTC was pruned after 29 days
   and 1 to 2 hours, by the next removal or cleanup in the repository
   (`RecoveryWindow_bug_early_prune`). A ref may now live up to a day longer
   than 30 days.
6. **The folder-gone path ignored a failed ref save.** Fixed: it saves the
   ref as the rail does (`saveRecoveryRef`, the next free suffix when the
   name holds another commit) and keeps the branch when no name can be
   written (`branchKeptReason: RECOVERY_REF_FAILED`). Before, it saved
   `refs/codara/removed-worktrees/<day>/<id>` create-only and ignored the
   error, then deleted the branch: if an earlier removal of the same
   worktree that UTC day was cut short after its ref and the branch got
   commits since, the newer commits were reachable nowhere here (their
   content was in `main`; the loss was the history).
   `WorktreeLifecycle_bug_missing_ref` puts it back.
7. **A removal that failed halfway deleted its own recovery ref.** Fixed:
   `removeLocked` keeps the ref after any failed `removeCopyWorktree` and
   names it in the refusal (`recoveryRef`), as `remove.ts` does; it expires
   with the others. git deletes files before it gives up on one it cannot
   delete and drops the registration even then, so the branch was then the
   only copy, and once it went the removed head was reachable nowhere here.
   The main path saves its ref with `saveRecoveryRef` too, so a retry the
   same day after new commits is not refused for the name.
   `WorktreeLifecycle_bug_partial_ref` puts it back.

What holds today, within the limits: Studio never deletes a folder or branch
whose last commit is not safe on GitHub, every head the automatic removal
deletes stays reachable through its recovery ref, two folders never check out
the same branch, and a merged idle worktree is eventually removed. Squash merges, merge commits,
deleted and force-pushed remote branches, a branch checked out again after
its merge, agents removing folders themselves and a crash between any two
steps do not break those.

## Reading a counterexample

`out/<config>.out` lists the states from the first to the broken one, each
under the action that led to it. A config that must fail runs on one TLC
worker, so its trace is the same on every run. `ghost` records what Studio's
deletes did; `a` and `g` are the two removals in progress, with `pc` the step
they are at.
