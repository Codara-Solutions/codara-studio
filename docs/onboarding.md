# In-app onboarding

New installations with no workspaces open the guide automatically. Existing users
can open it from Settings > General > Getting started. The guide saves its current
step in `onboarding.json` under the Codara home. Finishing later suppresses the
automatic launch until the user reopens the guide. Existing workspaces are preserved.

During development, renderer hot reload can show updated screens while Electron's
main process still runs older code. A missing onboarding IPC handler displays a
restart notice, and the guide can still be closed. Fully stop and restart
`npm run dev` after adding main-process handlers; reloading the window does not
register them in the existing main process.

The six steps cover orientation, local tools, account sign-in, choosing a project
folder, an interactive tour, and a readiness review. Tour actions open real Studio
surfaces and leave a small guide visible while the user explores. They do not send
an agent prompt or run a terminal command automatically.

## Local tools

The main process verifies Git, Python 3, Node.js, Claude Code, and Codex using their
version commands. Python is probed using the interpreter name the Claude hooks
actually use, so a Python 2 executable or a nonfunctional Windows Store alias does
not count as ready. System Node.js is for project tools and npm, not Cora's bundled
runtime.

Installers are selected from a fixed catalog:

| Platform | Installation |
| --- | --- |
| Windows | WinGet for Git, Python, Node.js, and Claude Code |
| macOS | Homebrew for Git, Python, Node.js, and Claude Code |
| All platforms with npm | npm global install for Codex |
| Missing package manager or other platforms | Official setup guides and a recheck action |

The user reviews the command before starting it. Only one installer runs at a time;
its output is bounded and remains available when the guide is reopened. Each
installation refreshes the environment and binary cache, then verifies the tool.
An exit code of zero without a working executable does not count as success.
Existing terminal shells may need to be reopened to receive the new PATH.

## Accounts

The guide reuses `AccountsSettings` in a simplified guided mode and the existing
`piSubscriptions` sign-in, authorization-code, cancellation, and runtime-install
flows. Credentials never enter onboarding persistence. Navigation pauses during
an active sign-in. A connected account and an installed CLI are separate checks;
users may skip either and return later.

## Verification

`npm test -- onboarding` covers dependency detection, installer routing, validation,
concurrency, failed installs, and progress normalization without installing software.
The Playwright onboarding spec covers the first-run UI, installer failure, cancelled
and completed sign-in, choosing a workspace, opening a real terminal, persistence,
and replay. Installer and provider responses are simulated in that spec.

Before release, also verify real installation and browser sign-in on clean Windows
and macOS machines, including a machine without WinGet or Homebrew. Those checks
require system changes and a provider account and are not unit tests.
