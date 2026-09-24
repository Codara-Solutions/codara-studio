# Glossary

The words Codara Studio uses in its UI, docs and code, grouped by topic. Each
entry gives the plain meaning first, then, where it helps, the type or file
that defines it (types are in `src/shared/types.ts` unless noted).

## Cora and runs

- **Cora.** The built-in orchestrating agent. You describe work in a Cora
  chat; Cora plans it, hands pieces to workers, checks the results and asks
  you only when it must. Cora runs on the Pi coding agent with Codara's
  extension in `resources/pi-cora/`. The `cora` CLI drives it from a terminal
  (see [cli.md](./cli.md)).
- **Run.** One Cora chat and everything it did: messages, steps, workers,
  board and whiteboard. Stored in `~/.codarastudio/runs/<id>/run.json`
  (`RunState`). Its status is one of idle, planning, running, reviewing,
  blocked, paused, complete, failed or cancelled (`RunStatus`).
- **Step.** A planned phase of a run (`StepState`): either a batch of workers
  (`worker_batch`) or a checkpoint with none (`brake`). Not the same as a loom
  step node.
- **Worker.** A task Cora hands to another agent (`WorkerTask`). Each try is
  a worker attempt (`WorkerAttempt`) that runs in its own pane with a runtime
  such as Claude Code, Codex, Grok or Pi, and a class: skeleton, feature, leaf
  or verifier. In workspace code, `Worker` also means any terminal pane that
  belongs to a workspace.
- **Verifier.** A worker class that re-checks another worker's output and
  returns a verdict (`VerifierVerdict`).
- **Wave.** A set of ready workers that do not conflict and so run in
  parallel (`src/shared/parallel-wave.ts`).
- **Board.** A chat's kanban of task cards (`RunBoard`, `BoardCard`) with the
  lanes idea, queued, running, blocked, review, done and failed. You and Cora
  both edit it, and so can a paired phone.
- **Whiteboard.** A chat's infinite canvas of cards and connections
  (`CoraWhiteboard`), shared between you and Cora. Standalone whiteboards are
  saved as `.coraboard` files. See [whiteboard-review.md](./whiteboard-review.md).
- **Cora profile.** A named Cora identity with its own global and
  per-workspace memory (`CoraProfile`).
- **Service pane and temporary pane.** Terminals a run owns. Temporary panes
  close when the run settles; service panes (a dev server, say) stay until
  the run is deleted.

## Automations

- **Automation.** Work that runs by itself: on a schedule, on a git or folder
  event, when another automation finishes, or on demand, with a budget and
  loop limits (`AutomationState`, driven by
  `src/main/orchestration/automation-loop.ts`).
- **Loom.** The graph an automation runs (`LoomGraph`), made of worker,
  guard, merge and step nodes (`LoomNodeDef`).
- **Loom step node.** A plain action with no AI inside a loom: a shell
  command, a script, an HTTP request, a file write or a notification
  (`src/main/orchestration/loom-steps.ts`). A "steps-only pass" has no worker
  at all.
- **Pass.** One execution of a loom, that is, one iteration of an
  automation's loop. Each pass is a run.

## Workspace and interface

- **Workspace.** A project folder, local or `ssh://<host>/...`, with its
  color, tabs and terminals (`Workspace`).
- **Copy-branch workspace.** A workspace backed by a new git worktree, so
  agents can work on a copy of the repository.
- **Dock, docked tab.** A tab placed inside a terminal tab's split grid
  instead of filling the whole area (`src/renderer/src/tabs/dock.ts`).
- **Browser tab, preview.** The built-in Chromium tab. The UI calls it the
  browser; the MCP tools that drive it are named `codara_preview_*`.
- **Capability Center.** The dialog for MCP servers, skills, Cora memory,
  worker models and session policy, opened with the **MCP and skills** button
  in the Cora composer
  (`src/renderer/src/components/AgentCapabilitiesDialog.tsx`).

## Accounts

See [accounts.md](./accounts.md) for how these fit together.

- **Account.** One sign-in with Claude, ChatGPT or Grok. It has a Cora side
  (the subscription Cora uses) and a CLI side (the login Claude Code, Codex or
  Grok uses), which hold the same sign-in.
- **Account 1.** Your own login in the CLI's usual home.
- **Active account.** The account a CLI's terminals, and new Cora chats, use.
  For Claude Code and Codex its login is the one in your own `~/.claude` or
  `~/.codex`.
- **Credential mirror.** The process that keeps an account's two sides
  holding the same, newest login (`credential-mirror.ts`).

## Plumbing

- **Agent socket.** The app's loopback JSON-RPC server, protected by a
  token and advertised in `~/.codarastudio/agent-socket.json`. The MCP server,
  the `cora` CLI and the hooks use it.
- **Tool set (roster).** One of the four sets of MCP tools the built-in server
  offers: studio, worker, execute and automation, chosen by `SPARK_MCP_MODE`.
  See [mcp-tools.md](./mcp-tools.md).
- **Hook.** The script Codara registers with Claude Code so that sessions in
  Codara panes report their events back to the app
  (`resources/claude-hooks/codara-hook.py`).
- **Remote access.** Pairing with the Codara phone app over the local
  network or the Codara relay (`src/main/remote-access/`). See
  [remote-access.md](./remote-access.md).
- **Harness benchmark.** `cora bench`, which scores the whole orchestration
  harness on seeded tasks (correctness, efficiency, discipline,
  orchestration). See [cli/README.md](../cli/README.md).
