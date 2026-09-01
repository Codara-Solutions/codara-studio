# Glossary

Terms as the code uses them. Sources are in `src/shared/types.ts` unless
noted.

- **Cora.** The built-in orchestrating agent. Runs on the bundled Pi
  coding-agent runtime with the Codara extension in `resources/pi-cora/`, or
  through a Claude or Codex CLI backend. The `cora` CLI drives it from a
  terminal.
- **Run.** One Cora conversation and its execution. Persisted as
  `~/.codarastudio/runs/<id>/run.json`; `RunState` holds steps, worker tasks,
  attempts, human messages, the board, and the whiteboard. Statuses are in
  `RunStatus` (idle, planning, running, reviewing, paused, blocked, complete,
  failed, ...).
- **Step.** A planned phase of a run (`StepState`: title, goal, kind
  `worker_batch` or `brake`). Not the same thing as a loom step node.
- **Worker.** A subagent task spawned by Cora (`WorkerTask`); each execution
  is a `WorkerAttempt` with a runtime (claude, codex, grok, pi) and a class
  (skeleton, feature, leaf, verifier). In workspace terms a `Worker` is also a
  terminal or orchestration pane that belongs to a workspace.
- **Wave.** The set of mutually compatible ready worker tasks launched in
  parallel (`src/shared/parallel-wave.ts`).
- **Verifier.** A worker class that checks other workers' output and returns a
  `VerifierVerdict`.
- **Board.** The per-run kanban of task cards (`RunBoard`, `BoardCard`) with
  lanes idea, queued, running, blocked, review, done, failed. Shared between
  you, Cora, and remote surfaces; editable by both.
- **Whiteboard.** A Cora-owned infinite canvas of nodes and edges stored in
  the run (`CoraWhiteboard`).
- **Automation.** A scheduled or triggered execution with status, iteration
  count, and budget (`AutomationState`), driven by
  `src/main/orchestration/automation-loop.ts`. Triggers are cron, git, or
  manual.
- **Loom.** The node graph an automation runs (`LoomGraph`): worker, guard,
  merge, and step nodes (`LoomNodeDef`). One pass of a loom is one run.
- **Loom step node.** A deterministic non-AI action inside a loom: shell,
  script, HTTP, file write, notification (`loom-steps.ts`). A "steps-only
  pass" has no worker at all.
- **Pass.** A single execution of a loom by an automation; an iteration of
  its loop.
- **Workspace.** A project folder (local path or `ssh://<host>/...`) with a
  color, its tabs, and its terminal workers (`Workspace`).
- **Dock / docked tab.** A tab laid out inside a terminal tab's split grid
  instead of filling the workbench (`src/renderer/src/tabs/dock.ts`).
- **Preview.** The built-in Chromium `<webview>` tab that agents drive through
  the `codara_preview_*` MCP tools.
- **Capability Center.** The dialog for MCP servers, skills, Cora memory,
  worker models, and session policy
  (`src/renderer/src/components/AgentCapabilitiesDialog.tsx`), opened from the
  "MCP and skills" button in the Cora composer.
- **Cora profile.** A named Cora identity with its own global and
  per-workspace memory (`CoraProfile`).
- **Account.** One identity with two halves: a Cora half (Pi OAuth
  subscription) and a CLI half (private Claude Code, Codex, or Grok login
  directory). "Account 1" is your personal login in the CLI's default home.
- **Active account.** The CLI half new Studio terminals sign in as. Separate
  from the Cora default, which is the subscription new Cora chats use.
- **Credential mirror.** The process that keeps an account's two halves
  holding the same OAuth credential (`credential-mirror.ts`).
- **Agent socket.** The loopback HTTP JSON-RPC server with a bearer token
  advertised in `~/.codarastudio/agent-socket.json`, used by the MCP server,
  the `cora` CLI, and hooks.
- **Roster.** One of the four MCP tool sets the bundled server exposes:
  studio, worker, execute, automation (selected by `SPARK_MCP_MODE`).
- **Service pane / temporary pane.** Run-owned terminals. Temporary ones close
  when the run settles; service panes survive until the run is deleted.
- **Remote access.** Phone pairing over a local listener or the Codara relay
  (`src/main/remote-access/`).
- **Harness benchmark.** `cora bench`: scores the whole orchestration harness
  on seeded tasks (correctness, efficiency, discipline, orchestration). See
  `cli/README.md`.
