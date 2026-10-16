# Worktree setup

A new git worktree has every tracked file and nothing else: no `.env`, no
`node_modules`, no build output. Worktree setup fills that gap from two files
you keep in the repository, so every worktree Codara makes starts ready,
whether you made it, an agent did, or Codara did for a GitHub issue or a Cora
worker. The code is in `src/main/worktree-setup/`, the file format and the
types the renderer shares are in `src/shared/worktree-setup.ts`.

## The two files

Both live at the root of the repository and are meant to be committed.

`.worktreeinclude` lists the ignored files to copy from the main checkout,
in gitignore syntax: one pattern per line, `#` for comments, `!` to leave
something out. It is the same file Claude Code reads for its own worktrees.
Only files git ignores are copied; tracked files are already in the worktree.

```
.env
.env.local
config/*.local.json
!config/secrets.local.json
```

`.codara/worktree.json` holds the rest:

```json
{
  "link": ["node_modules"],
  "setup": ["npm ci", "npm run codegen"],
  "setupWindows": "npm ci",
  "waitForSetup": true,
  "terminals": [
    { "name": "Dev server", "command": "npm run dev" },
    { "name": "Shell" }
  ]
}
```

| Key | What it does |
|---|---|
| `copy` | More patterns to copy, added to `.worktreeinclude`. |
| `link` | Ignored folders the worktree uses through a link to the main checkout's folder (a junction on Windows) instead of a copy. Plain paths inside the repository, no patterns. |
| `setup` | The command to run in the new worktree, as one string or a list of lines. The lines run one after another and setup stops at the first that fails. |
| `setupWindows` | Used instead of `setup` on Windows. Without it, Windows runs `setup`. |
| `waitForSetup` | Agents wait for setup before they start, and the terminals open once setup succeeded. |
| `terminals` | Terminals to open in a worktree you create from Codara, each with a `name` and an optional `command`. |

A key Codara does not know is reported as a warning, never an error. A file
that is not valid JSON fails the setup after the files were copied, with the
reason in the log.

You do not have to write them by hand. **Workspace actions > Create isolated
worktree** shows what a new worktree will get at the foot of the dialog, and
**Set up worktrees** (or **Edit setup**) opens a dialog that starts from what
it finds in the checkout: ignored `.env` files a worktree would miss, folders
such as `node_modules` worth linking, and an install command for the
lockfile. Settings > Git > **Worktree setup file** opens the same dialog.
Saving rewrites both files; comments in them are not kept.

## What happens when a worktree is made

1. Codara reads the two files from the main checkout, never from the new
   worktree, so a branch cannot change what runs. Both must be plain files:
   a symlinked file is ignored.
2. It links the `link` folders, then copies what the patterns match. A
   folder the setup command installs into is not linked, nor copied (see
   [Linked folders](#linked-folders)). A copy
   never overwrites a file the worktree already has, and on file systems that
   support it (APFS on macOS, Btrfs and XFS on Linux) the copy is a cheap
   clone. Copies stop at 1 GB or 20,000 files; the rest is listed as
   skipped, with a hint to link big folders instead. Symlinks inside a copied folder are recreated
   only when they point inside the repository. A link that git does not
   ignore is added to the repository's `info/exclude` under a Codara comment,
   so it never shows up as a change; when that fails, the link is taken out
   again rather than left for `git add -A` to commit. Links are recorded
   before the copies start.
3. When the setup command or a terminal command is new or changed for this
   repository and you did not create the worktree from the dialog that
   showed them, setup stops here and asks you first (see [Approving the setup command](#approving-the-setup-command)).
4. It runs the setup command in the worktree, then your own command (see
   below). Each runs without a terminal and without input, in its own
   process group (on Windows, Stop ends its whole process tree), and is
   stopped after 45 minutes. At most two setups run commands at
   the same time; the others wait their turn.

The commands see these variables:

| Variable | Value |
|---|---|
| `CODARA_ROOT_PATH` | The main checkout. |
| `CODARA_WORKTREE_PATH` | The new worktree (also the working directory). |
| `CODARA_WORKTREE_BRANCH` | Its branch, when it has one. |
| `CODARA_WORKSPACE_NAME` | Its name in the rail. |

On macOS and Linux the setup command runs as a `bash` script (`sh` when
there is no bash) with `set -e`. On Windows each line runs through
all lines of a step run in one `cmd` script (a `.cmd` file with `@echo off`),
so a `cd` or a `set` carries over to the next line, and the first line that
fails stops the step. Lines that start with a program such as `npm` are
called with `call`; a line that chains one after a builtin
(`cd app && npm ci`) should be split into two lines. In that script `%%` is
`%` and a `for` variable is written `%%i`. Your own command runs as a script in your
default shell (Settings > Terminal > **Default shell**; Git Bash on Windows
when it is the default), not in a terminal, so interactive startup files
such as `.zshrc` are not read; the `PATH` is the one a login shell gets.
PowerShell runs it with `-NoProfile`.

The status and the log live in the worktree's own git folder
(`.git/worktrees/<name>/codara-setup/`), so they go when the worktree goes.
The log saves the first 4 MB of output; `codara_worktree_setup` still
returns the latest lines.

### Your own command

Settings > Git > Worktrees > Advanced > **Copy-branch setup command** is a command of your own
for one repository, saved on this computer only. It runs after the
repository's setup command, or alone when the repository has no setup files.

## Approving the setup command

Anything that can write the repository (an agent, a branch you pulled, a
fresh clone) can change `.codara/worktree.json`, so its commands run only
once you approved them for that repository: the setup command and the
command of each terminal the file opens. Codara keeps the approvals in its
own home (`worktree-setup-approvals.json`), never in the repository, keyed
by the repository's shared git folder so every worktree of it counts. An
approval covers the exact setup command, the way it runs (a bash script on
macOS and Linux, one `cmd` per line on Windows) and each terminal's name and
command; any change to them, or a terminal added, asks again. A terminal
without a command is a plain shell and needs no approval.

- Creating a worktree from the dialog approves the commands it showed, as
  long as **Run setup commands** is on. The dialog lists each terminal's
  command and says so under the summary.
- A worktree made any other way (from the jump palette, by an agent through
  `codara_worktree_create`, for a GitHub issue, or for a Cora worker) with
  commands not yet approved gets its files copied and folders linked, and
  nothing runs. The setup list at the bottom right shows the exact setup
  command and terminal commands with **Run setup** (this once), **Always
  allow** them for the repository and **Don't run**, and a notification
  asks for you. No terminal opens before you decide; once you ran setup, a
  worktree from the jump palette gets its terminals as plain shells, without
  their commands. Agents, issues and workers never open the file's
  terminals.
- Your own command is yours and needs no approval.

## Watching and stopping it

Every setup Codara starts shows in a small list at the bottom right: running,
failed or stopped. A setup that succeeds shows **Ready** for a moment and
leaves; one that fails also raises a notification. **Log** opens the output
as it arrives, with what was copied, linked and skipped and the state of
each command. **Stop** ends the running command and everything it started;
**Run again** starts over with the current files and your current command.

In the create dialog, **Run setup commands** (on by default) turns off the
commands and the terminals for that one worktree. Files are still copied and
folders linked.

A setup waiting for your approval stays in the list with its command until
you run it, allow it or decline it; closing Codara ends it as stopped.

## Agents

`codara_worktree_create` starts setup and returns a `setup` summary next to
the worktree. When `.codara/worktree.json` sets `waitForSetup`, or the agent
passes `waitForSetup: true`, it waits up to five minutes for setup to end.
Otherwise the agent calls `codara_worktree_setup` with `wait: true` before it
builds or tests. A setup in the state `awaiting-approval` has not run its
command: the agent is told to tell you and never to run the command itself,
and `codara_worktree_setup` with `wait: true` keeps waiting while you decide. `codara_worktree_setup` returns the state, each command with
its exit code, the error and the end of the log; it waits up to nine minutes.
Without arguments it reports on the worktree the agent works in. See
[MCP tools](./mcp-tools.md).

Files that setup copied or linked and that are still unchanged do not block
`codara_worktree_remove`: Codara can make them again. A copied file that was
edited, and anything the setup command wrote, still blocks it like any other
ignored file.

A GitHub issue workspace runs setup too, and Cora is told to wait for it
before touching the code. A Cora worker's sandbox worktree runs it before the
worker starts, and waits for it when the file says so; a command that waits
for your approval does not hold the worker, which starts without it.

## What it does not cover

- Workspaces imported from a pull request: their checkout is untrusted, so
  no setup runs there.
- The worktrees a workflow gives an agent with `isolation: "worktree"`.
- SSH workspaces.

## Linked folders

A linked folder is the main checkout's own folder: an install, a build or a
delete in the worktree changes it for the main checkout and every other
worktree. So Codara does not link:

- a folder the setup command, your own command or a terminal's command
  installs into: `node_modules` for `npm ci`, `npm install`, `pnpm
  install`, `yarn`, `bun install` and `deno install`; `.venv` or `venv` for
  `uv sync`, `pip install`, `poetry install`, `pipenv install`, `pdm
  install`, `rye sync` and `python -m venv`; `vendor` for `composer install`
  and `go mod vendor`; `vendor/bundle` (or `vendor`) for `bundle install`,
  or the folder it is given with `--path`, `BUNDLE_PATH` or `bundle config
  set path`. It copies nothing there either: the install fills it. The
  create dialog and the editor say so.
- anything in a Cora worker's sandbox worktree, which is meant to share
  nothing with the main checkout.

Agents are told that linked folders are shared and never to install into or
delete them from a worktree.

## Things to know
- `info/exclude` is shared by every worktree of the repository, so an entry
  Codara adds for a link hides that path in all of them. Entries sit under a
  `# Folders Codara Studio links into worktrees` comment and can be deleted
  by hand.
- Removing a worktree first stops its setup, waits until it no longer
  writes there, and takes its links out, so nothing in the main checkout is
  deleted through them. Remove a worktree with linked folders from Codara
  (or take the links out first): a tool that follows a Windows junction
  while deleting would reach the main checkout's folder.
- A Cora worker that waits for setup stops waiting as soon as it is
  stopped.
