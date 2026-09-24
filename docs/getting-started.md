# Getting started

This page takes you from download to your first agent session: installing
the app, what the first-run guide checks and installs, and what to try once
it is done. The last section has notes for contributors who work on the
guide itself.

## Install

Download the app from
[studio.codarasolutions.com](https://studio.codarasolutions.com).

- **macOS:** open the `.dmg` and drag Codara Studio to Applications. Builds
  are signed and notarized.
- **Windows:** run the installer. Builds are not signed yet, so SmartScreen
  warns on first run; [SECURITY.md](../SECURITY.md) shows how to check the
  installer's hash before you continue.
- **Linux:** there is no download yet. Build an AppImage from source with
  `npm install && npm run package:linux` (see the
  [README](../README.md#build-from-source)).

The app updates itself: a new release is announced to running apps within
seconds of being published.

## The first-run guide

On a fresh install (no workspaces yet) Codara opens a short guide. You can
leave with **Finish later** at any point and come back from Settings,
General, **Getting started**. Your place in the guide is saved in
`~/.codarastudio/onboarding.json`; nothing you type into it, such as
credentials, is stored there. Workspaces you already have are never touched.

| Step | What happens |
|---|---|
| 1. Welcome | A one-screen introduction. |
| 2. Your tools | Codara checks the command-line tools it works with and offers to install missing ones. |
| 3. Connect an account | Sign in with Claude or ChatGPT. You can skip this and do it later. |
| 4. Your workspace | Pick the project folder you want to work in. |
| 5. Explore Studio | A guided tour of the main surfaces. |
| 6. Your first idea | A readiness check and a suggestion for a small first task. |

### Your tools

The guide checks these by running each one's version command:

| Tool | Why Codara wants it |
|---|---|
| Git | Checkpoints, source control and copy-branch workspaces. |
| Python 3 | Runs the hook that lets Codara follow Claude Code activity. |
| Node.js | Runs JavaScript project tools and installs Codex through npm. |
| Claude Code | Anthropic's terminal agent, if you use Claude. |
| Codex | OpenAI's terminal agent, if you use ChatGPT. |

A tool only counts as installed when it actually runs: a Python 2 binary, or
the Windows Store placeholder for Python, does not pass.

When a tool is missing, the guide shows the exact install command and waits
for you to start it:

| Platform | Installer |
|---|---|
| macOS | Homebrew for Git, Python, Node.js and Claude Code |
| Windows | WinGet for Git, Python, Node.js and Claude Code |
| Any platform with npm | `npm install -g @openai/codex` for Codex |
| No package manager | A link to the official setup page, and a **recheck** button |

Only one installer runs at a time, and its output stays visible if you close
and reopen the guide. Terminals that were already open may need to be
reopened to see the new `PATH`.

### Connect an account

Sign in with Claude or ChatGPT in your browser. The guide uses the same
sign-in as Settings, Agents, so everything in [accounts.md](./accounts.md)
applies. Grok accounts can be added later from Settings.

This step also offers **Install Pi**, which installs the Pi coding agent that
Cora runs on (`npm install -g @earendil-works/pi-coding-agent`). It is
optional: until you install Pi, Cora uses a Pi build bundled with the app.

### Explore Studio

The tour opens the real surfaces one at a time, with a small guide beside
them: Cora, the terminal, the browser, files, automations and the whiteboard.
It never sends a prompt to an agent or runs a command for you.

## Your first session

Once the guide is done, try these in your workspace:

1. **A terminal.** Press Cmd+T (Ctrl+T on Windows and Linux) and run
   `claude`, `codex`, `grok` or `pi` as you normally would.
2. **An agent pane.** Open the **+** menu in the tab bar and pick
   **Claude worker**, **Codex worker**, **Grok worker** or **Pi worker**.
   The first three show the workspace's recent sessions so you can resume
   one or start fresh; Pi starts right away.
3. **Cora.** Click **Cora** in the tab bar and describe a small change.
   Cora plans it, runs workers in their own panes, and shows progress on the
   chat's board.
4. **The browser.** Ask an agent to open your app in the browser and check
   its work. It uses the `codara_preview_*` tools listed in
   [mcp-tools.md](./mcp-tools.md).

Keyboard shortcuts are in
[shortcuts-and-settings.md](./shortcuts-and-settings.md), and
[glossary.md](./glossary.md) explains the terms you will see.

## For contributors

- The guide's code is `src/renderer/src/components/onboarding/` (UI),
  `src/main/onboarding.ts` (tool checks and installers) and
  `src/shared/onboarding.ts` (steps, tool catalog, tour).
- Renderer hot reload does not reload the main process. After adding an
  onboarding IPC handler, stop and restart `npm run dev`; until then the
  guide shows a restart notice and can still be closed.
- `npm test -- onboarding` covers tool detection, installer routing,
  concurrency, failed installs and saved progress without installing
  anything. `tests/e2e/onboarding.spec.ts` covers the first-run UI with
  simulated installers and sign-in.
- Before a release that changes the guide, also try a real install and
  browser sign-in on clean macOS and Windows machines, including one without
  Homebrew or WinGet.
