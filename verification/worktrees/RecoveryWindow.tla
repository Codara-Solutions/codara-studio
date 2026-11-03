---------------------------- MODULE RecoveryWindow ----------------------------
(***************************************************************************)
(* How long a recovery ref lives. Code: dateStamp (worktree-cleanup/       *)
(* remove.ts, agent-worktrees.ts) names the ref after the UTC day it was   *)
(* made, refs/codara/removed-worktrees/<YYYY-MM-DD>/<id>, and              *)
(* pruneRecoveryRefs (agent-worktrees.ts) deletes it once the end of that  *)
(* day is more than RECOVERY_REF_RETENTION_DAYS (30) before now. Every     *)
(* removal and cleanup in the repository runs the prune, so it can run at  *)
(* any moment.                                                             *)
(*                                                                         *)
(* Time counts in hours. One ref is made at any hour; the invariant says   *)
(* it lives the full window the settings and the PR promise.               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Window,   \* days kept (30)
    Bug       \* {"day_start"}: the old code, counting from the day's midnight

H == 24
MaxTime == (Window + 2) * H

VARIABLES now, made, present, early

vars == <<now, made, present, early>>

Init == now = 0 /\ made = MaxTime + 1 /\ present = FALSE /\ early = FALSE

Stamp == (made \div H) * H     \* Date.parse(`${date}T00:00:00Z`)

(* A removal saves the ref now (once is enough: refs do not interact). *)
Save ==
    /\ ~present /\ made > MaxTime
    /\ made' = now /\ present' = TRUE
    /\ UNCHANGED <<now, early>>

Tick == now < MaxTime /\ now' = now + 1 /\ UNCHANGED <<made, present, early>>

(* pruneRecoveryRefs: `at < now - 30 days` deletes it. *)
Prune ==
    /\ present
    /\ LET at == IF "day_start" \in Bug THEN Stamp ELSE Stamp + H IN
       at < now - Window * H
    /\ present' = FALSE
    /\ early' = (now - made < Window * H)
    /\ UNCHANGED <<now, made>>

Next == Save \/ Tick \/ Prune

Spec == Init /\ [][Next]_vars

(* A recovery ref is never pruned before it is Window days old. *)
KeptForWindow == ~early
=============================================================================
