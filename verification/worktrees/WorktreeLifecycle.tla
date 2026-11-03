-------------------------- MODULE WorktreeLifecycle --------------------------
(***************************************************************************)
(* Codara Studio's worktrees, from creation to removal, and everything     *)
(* that can happen to them meanwhile. See README.md for the code each      *)
(* action follows and what is left out.                                    *)
(*                                                                         *)
(* Studio side (src/main):                                                 *)
(*  - Create: createAgentWorktreeInner (agent-worktrees.ts) under the      *)
(*    repository lock; the folder is the branch name's slug, with -2 when  *)
(*    that folder exists (pickCheckoutDirName, git-worktrees.ts).          *)
(*  - The automatic removal of merged worktrees (worktree-cleanup/rail.ts  *)
(*    mode "auto-merged", then remove.ts removeOne): A* actions.           *)
(*  - The automatic cleanup of a row whose folder is gone (rail.ts mode    *)
(*    "auto", cleanUpUnregistered): AMissing.                              *)
(*  - An agent's codara_worktree_remove (removeAgentWorktree and           *)
(*    removeLocked, agent-worktrees.ts): G* actions.                       *)
(* Around them: agents editing, committing, pushing and writing ignored    *)
(* files; terminals, processes and tabs opening and closing; the agent's   *)
(* own pane closing; an agent running `git worktree remove` itself;        *)
(* GitHub opening and merging pull requests (squash or merge commit),      *)
(* deleting or force-pushing the remote branch; git fetch; Studio crashing *)
(* between any two steps.                                                  *)
(*                                                                         *)
(* Commits are numbers; each records its parents and its content (the set *)
(* of changes it holds), so a squash merge holds a branch's content        *)
(* without its commits. Time is only the order of events: "quiet for 30   *)
(* minutes" is the flag quiet, set by Quiet and cleared by a commit.       *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    Rows,        \* Studio's worktree rows (copy-branch workspaces)
    Branches,    \* branch names; each has two possible folders, slug and slug-2
    MaxCommits,  \* commits, squash and merge commits included
    MaxCrashes,
    Act,         \* actors on, beyond the defaults (README, "Actors")
    Bug,         \* historical bugs put back (README, "Configs")
    Fix          \* proposed fixes turned on (README, "Findings")

NONE == -1
NoPath == <<"-", 0>>
Paths == Branches \X {1, 2}
Commits == 0..MaxCommits

VARIABLES
    row,      \* Studio's rows: [st, p (folder), b (branch), owner (creating pane open), tab, born]
    disk,     \* per folder: "none", "yes", or "aside" (moved aside to be deleted)
    reg,      \* per folder: the branch git has checked out there, or "none"
    dirty,    \* per folder: {"tracked"} (tracked or untracked changes), {"ignored"} (kept ignored files)
    term,     \* per folder: a terminal pane, Cora run or dev server Studio lists there
    proc,     \* per folder: a process only the process scan sees
    ftab,     \* per folder: an editor tab of ANOTHER workspace on a file inside it
    quiet,    \* per folder: no git activity for 30 minutes
    lb, rb, trk, up,   \* per branch: local tip, tip on GitHub, origin/<b> here, upstream set
    openPr,   \* per branch: head of its open pull request, or NONE
    merged,   \* <<branch, head>> of every merged pull request (GitHub keeps their heads)
    rmain, tmain,      \* main on GitHub, and origin/main here
    par, cont, nc,     \* commit parents and content, next commit number
    rref,     \* per row: refs/codara/removed-worktrees/<day>/<row id>, or NONE
              \* (one day: the date part is RecoveryWindow.tla's question)
    rref, rec,      \* commits held by the rail's suffixed refs (<id>-2, -3, ...)
    lock,     \* the repository lock: "free", "auto", "agent"
    a,        \* the automatic removal in progress
    g,        \* an agent's codara_worktree_remove in progress
    crashes,
    ghost     \* what Studio's deletes did, for the invariants

wt   == <<row, disk, reg, dirty, term, proc, ftab, quiet>>
gitv == <<lb, rb, trk, up, openPr, merged, rmain, tmain, par, cont, nc>>
vars == <<wt, gitv, rref, rref, rec, lock, a, g, crashes, ghost>>

NoRow == [st |-> "none", p |-> NoPath, b |-> "none", owner |-> FALSE, tab |-> FALSE, born |-> 0]
Idle  == [pc |-> "idle", r |-> "none", p |-> NoPath, b |-> "none", head |-> NONE,
          caller |-> "none", tm |-> NONE]

Init ==
    /\ row = [r \in Rows |-> NoRow]
    /\ disk = [p \in Paths |-> "none"]
    /\ reg = [p \in Paths |-> "none"]
    /\ dirty = [p \in Paths |-> {}]
    /\ term = [p \in Paths |-> FALSE]
    /\ proc = [p \in Paths |-> FALSE]
    /\ ftab = [p \in Paths |-> FALSE]
    /\ quiet = [p \in Paths |-> FALSE]
    \* With Act "reuse", a branch may exist before any worktree (made by hand).
    /\ lb \in [Branches -> IF "reuse" \in Act THEN {NONE, 0} ELSE {NONE}]
    /\ rb = [b \in Branches |-> NONE]
    /\ trk = [b \in Branches |-> NONE]
    /\ up = [b \in Branches |-> FALSE]
    /\ openPr = [b \in Branches |-> NONE]
    /\ merged = {}
    /\ rmain = 0 /\ tmain = 0
    /\ par = [c \in Commits |-> {}]
    /\ cont = [c \in Commits |-> {}]
    /\ nc = 1
    /\ rref = [r \in Rows |-> NONE]
    /\ rec = {}
    /\ lock = "free"
    /\ a = Idle /\ g = Idle
    /\ crashes = 0
    /\ ghost = [ignored |-> FALSE, inUse |-> FALSE, unsafe |-> FALSE,
                collateral |-> FALSE, heads |-> {}]

-----------------------------------------------------------------------------
(* Git facts *)

RECURSIVE Anc(_)
Anc(c) == IF c = NONE THEN {} ELSE {c} \cup UNION {Anc(q) : q \in par[c]}

Head(p) == IF reg[p] = "none" THEN NONE ELSE lb[reg[p]]
CheckedOut(b) == \E q \in Paths : reg[q] = b

LocalReach == UNION {Anc(c) : c \in {lb[b] : b \in Branches} \cup {trk[b] : b \in Branches}
                                     \cup {tmain} \cup {rref[r] : r \in Rows} \cup rec}
RemoteReach == UNION {Anc(c) : c \in {rb[b] : b \in Branches} \cup {openPr[b] : b \in Branches}
                                      \cup {m[2] : m \in merged} \cup {rmain}}
(* Nothing of commit c is lost: its content is in main on GitHub, or     *)
(* GitHub holds the commit itself.                                       *)
Safe(c) == c = NONE \/ cont[c] \subseteq cont[rmain] \/ c \in RemoteReach

(* mergeFacts (inspect.ts): the first proof that holds, against origin/main. *)
Proof(b, c) ==
    IF c = NONE THEN "none"
    ELSE IF c \in Anc(tmain) THEN "ancestor"
    ELSE IF <<b, c>> \in merged THEN "pr"
    ELSE IF cont[c] \subseteq cont[tmain] THEN "content"
    ELSE "none"

(* unpushed / tipOnRemote (rail.ts): a gone upstream shows nothing. *)
Unpushed(b)    == up[b] /\ trk[b] # NONE /\ lb[b] \notin Anc(trk[b])
TipOnRemote(b) == up[b] /\ trk[b] # NONE /\ lb[b] \in Anc(trk[b])
(* hasOwnCommits: the head was committed after the row was made. *)
OwnCommit(r, c) == c >= row[r].born

(* autoMergedRefusal (rail.ts) returns null. *)
AutoProof(r, b, c) ==
    LET pf == Proof(b, c) IN
    /\ pf # "none"
    /\ ~Unpushed(b)
    /\ \/ pf = "pr"
       \/ pf = "ancestor" /\ OwnCommit(r, c)
       \/ pf = "content" /\ TipOnRemote(b)

(* proveMerged (agent-worktrees.ts), against the fetched target tm. *)
AgentProof(b, c, tm) ==
    \/ "own_branch_target" \in Bug
    \/ c \in Anc(tm) \/ <<b, c>> \in merged \/ cont[c] \subseteq cont[tm]

-----------------------------------------------------------------------------
(* Who uses a folder *)

LiveAt(p) == {s \in Rows : row[s].st = "live" /\ row[s].p = p}
OwnerOpenAt(p, except) == \E s \in LiveAt(p) : row[s].owner /\ s # except
TabAt(p) == \E s \in LiveAt(p) : row[s].tab

(* Everything that uses it, seen or not. *)
InUse(p, except) == OwnerOpenAt(p, except) \/ TabAt(p) \/ term[p] \/ proc[p] \/ ftab[p]
(* What checkRemoval's usageOf sees under requireKnownUsage. *)
AutoUse(p) == OwnerOpenAt(p, "none") \/ term[p] \/ proc[p]
(* What the window's held probe answers for the folder: the worktree's own *)
(* workspace's tabs, and a tab of any workspace on a file inside it        *)
(* (lastMomentRefusal, verifyRemovable). Bug "foreign_tab": before the fix *)
(* it answered for the worktree's own workspace only.                      *)
HeldSeen(p) == TabAt(p) \/ ("foreign_tab" \notin Bug /\ ftab[p])

(* Fix "bind": under the lock, the rows are read again, and the row asked *)
(* for must still be there and alone at its folder.                       *)
Bound(r, p) == "bind" \notin Fix \/ (row[r].st = "live" /\ LiveAt(p) = {r})

(* Between a removal's last check under the lock and its delete. Unless  *)
(* Act holds "late", nothing touches that folder in that window.          *)
InWindow(p) == (a.p = p /\ a.pc \in {"last", "ref", "git", "aside", "del"})
               \/ (g.p = p /\ g.pc \in {"ref", "git", "aside", "del"})
ActOk(p) == disk[p] = "yes" /\ ("late" \in Act \/ ~InWindow(p))

-----------------------------------------------------------------------------
(* Studio deletes folder p for row r. `except` is the row whose own open  *)
(* pane does not count: the agent that asked. A partial delete (Act       *)
(* "partial": git deletes files until one fails, drops the registration   *)
(* and reports a failure) leaves the folder with what was not deleted.    *)

Delete(p, r, except, partial) ==
    /\ ghost' = [ghost EXCEPT
          !.ignored = (@ \/ ("ignored" \in dirty[p])),
          !.inUse = (@ \/ InUse(p, except)),
          !.unsafe = (@ \/ ~Safe(Head(p))),
          !.collateral = (@ \/ (\E s \in LiveAt(p) : s # r)),
          !.heads = (@ \cup (IF Head(p) = NONE THEN {} ELSE {Head(p)}))]
    /\ disk' = [disk EXCEPT ![p] = IF partial THEN "yes" ELSE "none"]
    /\ reg' = [reg EXCEPT ![p] = "none"]
    /\ dirty' = [dirty EXCEPT ![p] = {}]
    /\ term' = [term EXCEPT ![p] = FALSE]
    /\ proc' = [proc EXCEPT ![p] = FALSE]
    /\ ftab' = [ftab EXCEPT ![p] = FALSE]
    /\ quiet' = [quiet EXCEPT ![p] = FALSE]

Partial == IF "partial" \in Act THEN BOOLEAN ELSE {FALSE}

(* deleteBranchIfAt: compare-and-delete, never a checked-out branch. *)
DropBranch(b, tip) ==
    IF lb[b] = tip /\ ~CheckedOut(b)
    THEN /\ lb' = [lb EXCEPT ![b] = NONE]
         /\ ghost' = [ghost EXCEPT !.unsafe = (@ \/ ~Safe(tip)), !.heads = (@ \cup {tip})]
    ELSE UNCHANGED <<lb, ghost>>

(* saveRecoveryRef (remove.ts): create-only, the next free suffix when taken. *)
SaveRail(r, c) ==
    IF rref[r] = NONE THEN rref' = [rref EXCEPT ![r] = c] /\ UNCHANGED rec
    ELSE IF rref[r] = c THEN UNCHANGED <<rref, rec>>
    ELSE rec' = rec \cup {c} /\ UNCHANGED rref

-----------------------------------------------------------------------------
(* Automatic removal of a merged worktree (mode "auto-merged") *)

AGo(pc) == a' = [a EXCEPT !.pc = pc]
AStop == a' = Idle /\ lock' = "free"

(* railWorktreeOverview offers the row; the renderer skips a held row. *)
AScan ==
    /\ a.pc = "idle" /\ "noauto" \notin Act
    /\ \E r \in Rows :
         LET p == row[r].p IN
         /\ row[r].st = "live" /\ disk[p] = "yes" /\ reg[p] # "none"
         /\ ~row[r].tab /\ quiet[p]
         /\ AutoProof(r, reg[p], Head(p))
         /\ a' = [Idle EXCEPT !.pc = "entry", !.r = r, !.p = p]
    /\ UNCHANGED <<wt, gitv, rref, rec, lock, g, crashes, ghost>>

(* cleanUpRailWorkspace: on screen, another workspace inside, the        *)
(* registration read under the lock, then quietRefusal.                  *)
AEntry ==
    /\ a.pc = "entry" /\ lock = "free"
    /\ LET r == a.r  p == a.p IN
       IF row[r].st = "live" /\ disk[p] = "yes" /\ ~row[r].tab /\ LiveAt(p) = {r}
          /\ reg[p] # "none" /\ quiet[p]
       THEN AGo("check") ELSE a' = Idle
    /\ UNCHANGED <<wt, gitv, rref, rec, lock, g, crashes, ghost>>

(* checkCleanupTargets, railRefusal and autoMergedRefusal, unlocked. *)
ACheck ==
    /\ a.pc = "check"
    /\ LET p == a.p  b == reg[p] IN
       IF b # "none" /\ ~AutoUse(p) /\ dirty[p] = {} /\ AutoProof(a.r, b, Head(p))
       THEN a' = [a EXCEPT !.pc = "lock", !.b = b, !.head = Head(p)]
       ELSE a' = Idle
    /\ UNCHANGED <<wt, gitv, rref, rec, lock, g, crashes, ghost>>

ALock ==
    /\ a.pc = "lock" /\ lock = "free"
    /\ lock' = "auto" /\ AGo("recheck")
    /\ UNCHANGED <<wt, gitv, rref, rec, g, crashes, ghost>>

(* removeOne: checkRemoval again under the lock and the same fingerprint *)
(* (head, branch, blockers, local work, merge state; not the proof kind). *)
ARecheck ==
    /\ a.pc = "recheck"
    /\ LET p == a.p IN
       IF reg[p] = a.b /\ Head(p) = a.head /\ ~AutoUse(p) /\ dirty[p] = {}
          /\ Proof(a.b, a.head) # "none" /\ Bound(a.r, p)
       THEN AGo("last") /\ UNCHANGED lock
       ELSE AStop
    /\ UNCHANGED <<wt, gitv, rref, rec, g, crashes, ghost>>

(* beforeRemove = lastMomentRefusal: on screen, or held by its tabs. *)
ALast ==
    /\ a.pc = "last"
    /\ IF ~HeldSeen(a.p) THEN AGo("ref") /\ UNCHANGED lock ELSE AStop
    /\ UNCHANGED <<wt, gitv, rref, rec, g, crashes, ghost>>

ARef ==
    /\ a.pc = "ref"
    /\ SaveRail(a.r, a.head) /\ AGo("git")
    /\ UNCHANGED <<wt, gitv, lock, g, crashes, ghost>>

(* removeCopyWorktree without force: tryRemoveWorktreeOnce's status sees *)
(* tracked and untracked changes; `git worktree remove` deletes ignored  *)
(* files without asking. On a failure the refs stay.                     *)
AGit ==
    /\ a.pc = "git"
    /\ LET p == a.p IN
       IF "tracked" \in dirty[p]
       THEN AStop /\ UNCHANGED <<wt, ghost>>
       ELSE IF "no_aside" \notin Bug
       THEN /\ AGo("aside") /\ disk' = [disk EXCEPT ![p] = "aside"]
            /\ UNCHANGED <<lock, row, reg, dirty, term, proc, ftab, quiet, ghost>>
       ELSE \E part \in Partial :
              /\ Delete(p, a.r, "none", part)
              /\ IF part THEN AStop ELSE AGo("branch") /\ UNCHANGED lock
              /\ UNCHANGED row
    /\ UNCHANGED <<gitv, rref, rec, g, crashes>>

(* The folder is moved aside first (git worktree move), so nothing new   *)
(* can start using or writing it by its path; then everything is checked *)
(* again, and it is put back if anything showed up. A handle opened      *)
(* before the move still writes (Act "handle"). Bug "no_aside": before   *)
(* fix/worktree-move-aside it was deleted in place.                      *)
AAside ==
    /\ a.pc = "aside"
    /\ LET p == a.p IN
       IF dirty[p] # {} \/ Head(p) # a.head \/ AutoUse(p) \/ HeldSeen(p)
       THEN /\ disk' = [disk EXCEPT ![p] = "yes"] /\ AStop
            /\ UNCHANGED <<row, reg, dirty, term, proc, ftab, quiet, ghost>>
       ELSE AGo("del") /\ UNCHANGED <<wt, lock, ghost>>
    /\ UNCHANGED <<gitv, rref, rec, g, crashes>>

ADel ==
    /\ a.pc = "del"
    /\ \E part \in Partial :
         /\ Delete(a.p, a.r, "none", FALSE)
         /\ IF part THEN AStop ELSE AGo("branch") /\ UNCHANGED lock
    /\ UNCHANGED <<row, gitv, rref, rec, g, crashes>>

(* deleteBranchIfAt; the lock is let go before the state update. *)
ABranch ==
    /\ a.pc = "branch"
    /\ DropBranch(a.b, a.head)
    /\ AGo("row") /\ lock' = "free"
    /\ UNCHANGED <<wt, rb, trk, up, openPr, merged, rmain, tmain, par, cont, nc, rref, rec, g, crashes>>

ARow ==
    /\ a.pc = "row"
    /\ row' = [row EXCEPT ![a.r].st = "gone"] /\ a' = Idle
    /\ UNCHANGED <<disk, reg, dirty, term, proc, ftab, quiet, gitv, rref, rec, lock, g, crashes, ghost>>

(* Mode "auto": the folder and its registration are gone; under the lock *)
(* the branch goes if merged and pushed, with a recovery ref, and the row *)
(* is dropped (cleanUpUnregistered).                                      *)
AMissing ==
    /\ a.pc = "idle" /\ lock = "free" /\ "noauto" \notin Act
    /\ \E r \in Rows :
         LET p == row[r].p  b == row[r].b  tip == lb[b] IN
         /\ row[r].st = "live" /\ disk[p] = "none" /\ reg[p] = "none"
         /\ ~row[r].owner
         /\ tip # NONE => (Proof(b, tip) # "none" /\ ~Unpushed(b))
         /\ IF tip # NONE /\ ~CheckedOut(b)
            THEN SaveRail(r, tip) /\ DropBranch(b, tip)
            ELSE UNCHANGED <<rref, rec, lb, ghost>>
         /\ row' = [row EXCEPT ![r].st = "gone"]
    /\ UNCHANGED <<disk, reg, dirty, term, proc, ftab, quiet,
                   rb, trk, up, openPr, merged, rmain, tmain, par, cont, nc, lock, a, g, crashes>>

-----------------------------------------------------------------------------
(* An agent's codara_worktree_remove *)

GGo(pc) == g' = [g EXCEPT !.pc = pc]
GStop == g' = Idle /\ lock' = "free"
Except(x) == IF x.caller = "owner" THEN x.r ELSE "none"
OwnerBlocks(r, caller) == caller = "other" /\ row[r].owner /\ "owner_pane" \notin Bug

(* verifyRemovable's blockers; `scan` is whether processes are scanned.   *)
(* Bug "agent_tabs": before the fix it never asked the window about tabs. *)
AgentBlocked(r, caller, p, scan) ==
    \/ OwnerBlocks(r, caller)
    \/ dirty[p] # {}
    \/ term[p]
    \/ scan /\ proc[p]
    \/ "agent_tabs" \notin Bug /\ HeldSeen(p)

(* Unlocked check, with the fetch of the target and the process scan. *)
GVerify ==
    /\ "agentrm" \in Act /\ g.pc = "idle"
    /\ \E r \in Rows, caller \in {"owner", "other"} :
         LET p == row[r].p  b == row[r].b IN
         /\ row[r].st = "live" /\ disk[p] = "yes" /\ reg[p] = b
         /\ caller = "owner" => row[r].owner
         /\ ~AgentBlocked(r, caller, p, TRUE)
         /\ AgentProof(b, lb[b], rmain)
         /\ tmain' = rmain
         /\ g' = [Idle EXCEPT !.pc = "lock", !.r = r, !.p = p, !.b = b, !.head = lb[b],
                              !.caller = caller, !.tm = rmain]
    /\ UNCHANGED <<wt, lb, rb, trk, up, openPr, merged, rmain, par, cont, nc, rref, rec, lock, a, crashes, ghost>>

GLock ==
    /\ g.pc = "lock" /\ lock = "free"
    /\ lock' = "agent" /\ GGo("recheck")
    /\ UNCHANGED <<wt, gitv, rref, rec, a, crashes, ghost>>

(* removeLocked: verifyRemovable again, pinned target, scanProcesses true *)
(* (Bug "no_rescan": false, before fix/worktree-move-aside).              *)
GRecheck ==
    /\ g.pc = "recheck"
    /\ LET r == g.r  p == g.p  b == g.b IN
       IF row[r].st = "live" /\ disk[p] = "yes" /\ reg[p] = b /\ lb[b] = g.head /\ Bound(r, p)
          /\ ~AgentBlocked(r, g.caller, p, "no_rescan" \notin Bug)
          /\ AgentProof(b, g.head, g.tm)
       THEN GGo("ref") /\ UNCHANGED lock
       ELSE GStop
    /\ UNCHANGED <<wt, gitv, rref, rec, a, crashes, ghost>>

(* saveRecoveryRef, as the rail does: create-only, the next free suffix *)
(* when the name holds another commit. Bug "drop_ref" (before            *)
(* fix/worktree-recovery-refs): a plain create-only update-ref, refused  *)
(* when the name was taken.                                               *)
GRef ==
    /\ g.pc = "ref"
    /\ IF "drop_ref" \notin Bug
       THEN SaveRail(g.r, g.head) /\ GGo("git") /\ UNCHANGED lock
       ELSE IF rref[g.r] \in {NONE, g.head}
       THEN rref' = [rref EXCEPT ![g.r] = g.head] /\ GGo("git") /\ UNCHANGED <<lock, rec>>
       ELSE GStop /\ UNCHANGED <<rref, rec>>
    /\ UNCHANGED <<wt, gitv, a, crashes, ghost>>

(* A failed removeCopyWorktree keeps its ref: git may have deleted files *)
(* and the registration before it failed, so the ref may be the only     *)
(* copy left (finding 7). Bug "drop_ref": it was deleted again then.     *)
DropAgentRef ==
    IF "drop_ref" \in Bug
    THEN rref' = IF rref[g.r] = g.head THEN [rref EXCEPT ![g.r] = NONE] ELSE rref
    ELSE UNCHANGED rref

GGit ==
    /\ g.pc = "git"
    /\ LET p == g.p IN
       IF "tracked" \in dirty[p]
       THEN GStop /\ DropAgentRef /\ UNCHANGED <<wt, ghost>>
       ELSE IF "no_aside" \notin Bug
       THEN /\ GGo("aside") /\ disk' = [disk EXCEPT ![p] = "aside"]
            /\ UNCHANGED <<lock, row, reg, dirty, term, proc, ftab, quiet, rref, ghost>>
       ELSE \E part \in Partial :
              /\ Delete(p, g.r, Except(g), part)
              /\ IF part THEN GStop /\ DropAgentRef ELSE GGo("branch") /\ UNCHANGED <<lock, rref>>
              /\ UNCHANGED row
    /\ UNCHANGED <<gitv, rec, a, crashes>>

GAside ==
    /\ g.pc = "aside"
    /\ LET p == g.p IN
       IF dirty[p] # {} \/ Head(p) # g.head \/ AgentBlocked(g.r, g.caller, p, "no_rescan" \notin Bug)
       THEN /\ disk' = [disk EXCEPT ![p] = "yes"] /\ GStop /\ DropAgentRef
            /\ UNCHANGED <<row, reg, dirty, term, proc, ftab, quiet, ghost>>
       ELSE GGo("del") /\ UNCHANGED <<wt, lock, rref, ghost>>
    /\ UNCHANGED <<gitv, rec, a, crashes>>

GDel ==
    /\ g.pc = "del"
    /\ \E part \in Partial :
         /\ Delete(g.p, g.r, Except(g), FALSE)
         /\ IF part THEN GStop /\ DropAgentRef ELSE GGo("branch") /\ UNCHANGED <<lock, rref>>
    /\ UNCHANGED <<row, gitv, rec, a, crashes>>

GBranch ==
    /\ g.pc = "branch"
    /\ DropBranch(g.b, g.head) /\ GGo("row")
    /\ UNCHANGED <<wt, rb, trk, up, openPr, merged, rmain, tmain, par, cont, nc, rref, rec, lock, a, crashes>>

GRow ==
    /\ g.pc = "row"
    /\ row' = [row EXCEPT ![g.r].st = "gone"] /\ GStop
    /\ UNCHANGED <<disk, reg, dirty, term, proc, ftab, quiet, gitv, rref, rec, a, crashes, ghost>>

(* The folder is already gone (verifyRemovable's alreadyRemoved; the     *)
(* creator's open pane still blocks another agent). Under the lock the    *)
(* branch goes if its tip is merged by ancestry or content, after a       *)
(* recovery ref saved like the rail's, with a free suffix; when none can  *)
(* be written the branch stays (finding 6). Bug "ignore_ref_save": a      *)
(* create-only save whose failure was ignored.                            *)
GMissing ==
    /\ "agentrm" \in Act /\ g.pc = "idle" /\ lock = "free"
    /\ \E r \in Rows, caller \in {"owner", "other"} :
         LET p == row[r].p  b == row[r].b  tip == lb[b] IN
         /\ row[r].st = "live" /\ disk[p] = "none"
         /\ caller = "owner" => row[r].owner
         /\ ~OwnerBlocks(r, caller)
         /\ IF tip # NONE /\ ~CheckedOut(b) /\ (tip \in Anc(tmain) \/ cont[tip] \subseteq cont[tmain])
            THEN /\ IF "ignore_ref_save" \notin Bug THEN SaveRail(r, tip)
                    ELSE /\ rref' = IF rref[r] = NONE THEN [rref EXCEPT ![r] = tip] ELSE rref
                         /\ UNCHANGED rec
                 /\ DropBranch(b, tip)
            ELSE UNCHANGED <<rref, rec, lb, ghost>>
         /\ row' = [row EXCEPT ![r].st = "gone"]
    /\ UNCHANGED <<disk, reg, dirty, term, proc, ftab, quiet,
                   rb, trk, up, openPr, merged, rmain, tmain, par, cont, nc, lock, a, g, crashes>>

-----------------------------------------------------------------------------
(* Creating a worktree, under the lock: a new branch from origin/main, or *)
(* (Act "reuse") an existing branch checked out again.                    *)

FreePaths(b) == {k \in {1, 2} : disk[<<b, k>>] = "none" /\ reg[<<b, k>>] = "none"
                                /\ ("paths" \notin Fix \/ LiveAt(<<b, k>>) = {})}

Create(r, b, mode) ==
    /\ row[r].st = "none" /\ lock = "free" /\ ~CheckedOut(b)
    /\ \/ mode = "new" /\ lb[b] = NONE
       \/ mode = "checkout" /\ "reuse" \in Act /\ lb[b] # NONE
    /\ FreePaths(b) # {}
    /\ LET p == <<b, IF 1 \in FreePaths(b) THEN 1 ELSE 2>> IN
       /\ row' = [row EXCEPT ![r] = [st |-> "live", p |-> p, b |-> b, owner |-> TRUE,
                                     tab |-> FALSE, born |-> nc]]
       /\ disk' = [disk EXCEPT ![p] = "yes"]
       /\ reg' = [reg EXCEPT ![p] = b]
       /\ dirty' = [dirty EXCEPT ![p] = {}]
       /\ quiet' = [quiet EXCEPT ![p] = FALSE]
    /\ lb' = IF mode = "new" THEN [lb EXCEPT ![b] = tmain] ELSE lb
    /\ up' = IF mode = "new" THEN [up EXCEPT ![b] = FALSE] ELSE up
    /\ UNCHANGED <<term, proc, ftab, rb, trk, openPr, merged, rmain, tmain, par, cont, nc,
                   rref, rec, lock, a, g, crashes, ghost>>

-----------------------------------------------------------------------------
(* Agents, the user and their tools, on a folder *)

Others == <<rref, rec, lock, a, g, crashes, ghost>>

SetDirty(p, d) ==
    /\ dirty' = [dirty EXCEPT ![p] = d]
    /\ UNCHANGED <<row, disk, reg, term, proc, ftab, quiet, gitv, Others>>

Edit(p)         == ActOk(p) /\ reg[p] # "none" /\ SetDirty(p, dirty[p] \cup {"tracked"})
Discard(p)      == "tracked" \in dirty[p] /\ SetDirty(p, dirty[p] \ {"tracked"})
WriteIgnored(p) == "ignored" \in Act /\ (ActOk(p) \/ ("handle" \in Act /\ disk[p] = "aside"))
                   /\ SetDirty(p, dirty[p] \cup {"ignored"})
DropIgnored(p)  == "ignored" \in dirty[p] /\ SetDirty(p, dirty[p] \ {"ignored"})

Commit(p) ==
    /\ ActOk(p) /\ reg[p] # "none" /\ "tracked" \in dirty[p] /\ nc <= MaxCommits
    /\ LET b == reg[p] IN
       /\ par' = [par EXCEPT ![nc] = {lb[b]}]
       /\ cont' = [cont EXCEPT ![nc] = cont[lb[b]] \cup {nc}]
       /\ lb' = [lb EXCEPT ![b] = nc]
    /\ nc' = nc + 1
    /\ dirty' = [dirty EXCEPT ![p] = @ \ {"tracked"}]
    /\ quiet' = [quiet EXCEPT ![p] = FALSE]
    /\ UNCHANGED <<row, disk, reg, term, proc, ftab, rb, trk, up, openPr, merged, rmain, tmain, Others>>

(* git push -u: GitHub, origin/<b> and an open pull request follow. *)
Push(p) ==
    /\ reg[p] # "none"
    /\ LET b == reg[p] IN
       /\ lb[b] # NONE /\ (rb[b] # lb[b] \/ ~up[b])
       /\ rb' = [rb EXCEPT ![b] = lb[b]]
       /\ trk' = [trk EXCEPT ![b] = lb[b]]
       /\ up' = [up EXCEPT ![b] = TRUE]
       /\ openPr' = IF openPr[b] # NONE THEN [openPr EXCEPT ![b] = lb[b]] ELSE openPr
    /\ UNCHANGED <<wt, lb, merged, rmain, tmain, par, cont, nc, Others>>

Quiet(p) ==
    /\ disk[p] = "yes" /\ ~quiet[p]
    /\ quiet' = [quiet EXCEPT ![p] = TRUE]
    /\ UNCHANGED <<row, disk, reg, dirty, term, proc, ftab, gitv, Others>>

Flip(f, p, on) ==
    /\ f' = [f EXCEPT ![p] = on]
    /\ IF on THEN ActOk(p) /\ ~f[p] ELSE f[p]

TermFlip(p, on) == "uses" \in Act /\ Flip(term, p, on)
                   /\ UNCHANGED <<row, disk, reg, dirty, proc, ftab, quiet, gitv, Others>>
ProcFlip(p, on) == "proc" \in Act /\ Flip(proc, p, on)
                   /\ UNCHANGED <<row, disk, reg, dirty, term, ftab, quiet, gitv, Others>>
FTabFlip(p, on) == "ftab" \in Act /\ Flip(ftab, p, on)
                   /\ UNCHANGED <<row, disk, reg, dirty, term, proc, quiet, gitv, Others>>

TabFlip(r, on) ==
    /\ "tabs" \in Act /\ row[r].st = "live" /\ row[r].tab # on
    /\ on => ActOk(row[r].p)
    /\ row' = [row EXCEPT ![r].tab = on]
    /\ UNCHANGED <<disk, reg, dirty, term, proc, ftab, quiet, gitv, Others>>

(* The pane of the agent that made the worktree closes for good. *)
OwnerCloses(r) ==
    /\ row[r].st = "live" /\ row[r].owner
    /\ row' = [row EXCEPT ![r].owner = FALSE]
    /\ UNCHANGED <<disk, reg, dirty, term, proc, ftab, quiet, gitv, Others>>

(* Act "partial": the user deletes what a failed removal left. *)
DeleteRest(p) ==
    /\ "partial" \in Act /\ disk[p] = "yes" /\ reg[p] = "none"
    /\ disk' = [disk EXCEPT ![p] = "none"]
    /\ dirty' = [dirty EXCEPT ![p] = {}]
    /\ term' = [term EXCEPT ![p] = FALSE]
    /\ proc' = [proc EXCEPT ![p] = FALSE]
    /\ ftab' = [ftab EXCEPT ![p] = FALSE]
    /\ UNCHANGED <<row, reg, quiet, gitv, Others>>

(* Act "self": an agent runs `git worktree remove` itself (git refuses    *)
(* changes, deletes ignored files), maybe deleting its merged branch;    *)
(* Studio's row stays until the rail notices.                            *)
SelfRemove(p, dropBranch) ==
    /\ "self" \in Act /\ ActOk(p) /\ reg[p] # "none" /\ "tracked" \notin dirty[p]
    /\ disk' = [disk EXCEPT ![p] = "none"]
    /\ reg' = [reg EXCEPT ![p] = "none"]
    /\ dirty' = [dirty EXCEPT ![p] = {}]
    /\ term' = [term EXCEPT ![p] = FALSE]
    /\ proc' = [proc EXCEPT ![p] = FALSE]
    /\ ftab' = [ftab EXCEPT ![p] = FALSE]
    /\ quiet' = [quiet EXCEPT ![p] = FALSE]
    /\ lb' = IF dropBranch /\ Safe(lb[reg[p]]) THEN [lb EXCEPT ![reg[p]] = NONE] ELSE lb
    /\ UNCHANGED <<row, rb, trk, up, openPr, merged, rmain, tmain, par, cont, nc, Others>>

-----------------------------------------------------------------------------
(* GitHub and git fetch *)

OpenPr(b) ==
    /\ rb[b] # NONE /\ openPr[b] = NONE /\ <<b, rb[b]>> \notin merged /\ rb[b] \notin Anc(rmain)
    /\ openPr' = [openPr EXCEPT ![b] = rb[b]]
    /\ UNCHANGED <<wt, lb, rb, trk, up, merged, rmain, tmain, par, cont, nc, Others>>

MergePr(b, kind) ==
    /\ openPr[b] # NONE /\ nc <= MaxCommits
    /\ par' = [par EXCEPT ![nc] = IF kind = "squash" THEN {rmain} ELSE {rmain, openPr[b]}]
    /\ cont' = [cont EXCEPT ![nc] = cont[rmain] \cup cont[openPr[b]]]
    /\ rmain' = nc /\ nc' = nc + 1
    /\ merged' = merged \cup {<<b, openPr[b]>>}
    /\ openPr' = [openPr EXCEPT ![b] = NONE]
    /\ UNCHANGED <<wt, lb, rb, trk, up, tmain, Others>>

DeleteRemote(b) ==
    /\ rb[b] # NONE /\ openPr[b] = NONE
    /\ rb' = [rb EXCEPT ![b] = NONE]
    /\ UNCHANGED <<wt, lb, trk, up, openPr, merged, rmain, tmain, par, cont, nc, Others>>

(* Act "force": someone reuses the remote branch, resetting it to main. *)
ForcePush(b) ==
    /\ "force" \in Act /\ rb[b] # NONE /\ rb[b] # rmain /\ openPr[b] = NONE
    /\ rb' = [rb EXCEPT ![b] = rmain]
    /\ UNCHANGED <<wt, lb, trk, up, openPr, merged, rmain, tmain, par, cont, nc, Others>>

(* git fetch --prune *)
Fetch ==
    /\ tmain # rmain \/ trk # rb
    /\ tmain' = rmain /\ trk' = rb
    /\ UNCHANGED <<wt, lb, rb, up, openPr, merged, rmain, par, cont, nc, Others>>

(* Studio quits or crashes: the in-memory lock and both removals are gone. *)
(* A folder left aside goes back (restoreAsideWorktrees, under the lock  *)
(* before the next removal or cleanup; here at once).                    *)
Crash ==
    /\ crashes < MaxCrashes /\ (a.pc # "idle" \/ g.pc # "idle")
    /\ crashes' = crashes + 1
    /\ a' = Idle /\ g' = Idle /\ lock' = "free"
    /\ disk' = [p \in Paths |-> IF disk[p] = "aside" THEN "yes" ELSE disk[p]]
    /\ UNCHANGED <<row, reg, dirty, term, proc, ftab, quiet, gitv, rref, rec, ghost>>

-----------------------------------------------------------------------------

AutoStep  == AEntry \/ ACheck \/ ALock \/ ARecheck \/ ALast \/ ARef \/ AGit \/ AAside
             \/ ADel \/ ABranch \/ ARow
AgentStep == GLock \/ GRecheck \/ GRef \/ GGit \/ GAside \/ GDel \/ GBranch \/ GRow

World ==
    \/ \E r \in Rows, b \in Branches, m \in {"new", "checkout"} : Create(r, b, m)
    \/ \E p \in Paths : Edit(p) \/ Discard(p) \/ WriteIgnored(p) \/ DropIgnored(p)
                        \/ Commit(p) \/ Push(p) \/ Quiet(p)
                        \/ \E on \in BOOLEAN : TermFlip(p, on) \/ ProcFlip(p, on) \/ FTabFlip(p, on)
                        \/ \E d \in BOOLEAN : SelfRemove(p, d)
                        \/ DeleteRest(p)
    \/ \E r \in Rows : OwnerCloses(r) \/ \E on \in BOOLEAN : TabFlip(r, on)
    \/ \E b \in Branches : OpenPr(b) \/ DeleteRemote(b) \/ ForcePush(b)
                           \/ \E k \in {"squash", "merge"} : MergePr(b, k)
    \/ Fetch

Next == AScan \/ AutoStep \/ AMissing \/ GVerify \/ GMissing \/ AgentStep \/ World \/ Crash

Spec == Init /\ [][Next]_vars
        /\ WF_vars(AScan) /\ WF_vars(AutoStep) /\ WF_vars(AMissing) /\ WF_vars(AgentStep)

-----------------------------------------------------------------------------
(* Invariants, in plain words *)

(* Studio never deletes kept ignored files (a .env, notes, outputs). *)
NoIgnoredLost == ~ghost.ignored

(* Studio never deletes a folder something uses: an agent's open pane     *)
(* (but the one that asked), a tab, a terminal, a process.                *)
NeverRemovedInUse == ~ghost.inUse

(* Studio never deletes a folder, or a branch, whose last commit is not  *)
(* safe on GitHub (in main by content, or held there).                    *)
NoUnsafeRemoved == ~ghost.unsafe

(* Every head Studio deleted stays reachable here (the recovery ref; its *)
(* 30 days are RecoveryWindow.tla's question).                            *)
RemovedReachable == ghost.heads \subseteq LocalReach

(* Removing one row never deletes another row's folder. *)
NoCollateral == ~ghost.collateral

OneCheckoutPerBranch ==
    \A p, q \in Paths : p # q /\ reg[p] # "none" => reg[p] # reg[q]

OneRowPerPath ==
    \A r, s \in Rows : r # s /\ row[r].st = "live" /\ row[s].st = "live" => row[r].p # row[s].p

(* Must break: the removal paths are reachable at all. *)
NothingRemoved == ghost.heads = {}

(* Liveness: a row that stays merged, clean, idle and unused is removed. *)
IdleMerged(r) ==
    LET p == row[r].p IN
    /\ row[r].st = "live" /\ disk[p] = "yes" /\ reg[p] # "none"
    /\ AutoProof(r, reg[p], Head(p))
    /\ dirty[p] = {} /\ ~InUse(p, "none") /\ quiet[p] /\ LiveAt(p) = {r}

MergedIdleLeaves == \A r \in Rows : <>[]IdleMerged(r) => <>(row[r].st = "gone")
=============================================================================
