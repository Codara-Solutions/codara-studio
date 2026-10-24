# Accounts

This page explains how Codara Studio handles your agent sign-ins: what an
account is, how to add one, what the Active account does, what happens when
you switch, and who keeps the logins fresh. It is written for users. The
design behind it, with file references, is in
[architecture.md](./architecture.md#accounts).

## The short version

- An **account** is one sign-in with a provider: Claude, ChatGPT or Grok. One
  sign-in serves both Cora and the matching terminal tool (Claude Code, Codex
  or Grok) in the terminals Codara opens.
- Accounts stay inside Codara, in `~/.codarastudio`. Your own Claude Code,
  Codex and Grok logins (`~/.claude`, `~/.claude.json`, `~/.codex`,
  `~/.grok`) are never changed.
- A plain `claude` typed in any other terminal app uses the Active Claude
  account too, while **Use the Active Claude account in other terminals**
  (Settings, Accounts; on by default) is on. See
  [Claude in other terminals](#claude-in-other-terminals).
- For each provider, one account is the **Active** one. New Codara terminals
  and new Cora chats use it.
- Your own login on this computer (the **System login**) can be used as an
  account too. Codara uses it as it is and never changes it.
- Pi is separate: Pi panes run your own Pi with your own `~/.pi`.

## Adding an account

Open Settings (Cmd+, on macOS, Ctrl+, elsewhere), go to **Accounts**, and
click **Add account**. A provider with no account yet also has its own
**Sign in to ...** button. The first-run guide offers the same sign-in (see
[getting-started.md](./getting-started.md)), and so does the Cora chat: with
no account connected, the welcome screen says so and opens these settings,
and a turn that fails because an account is missing or signed out shows
**Open accounts** next to **Retry**. From a terminal:

```sh
cora auth add anthropic "Work Claude"
```

The sign-in page opens in your browser and the command finishes in your
terminal. Codara keeps the new account in its own folder and never touches
`~/.claude` or `~/.codex`. Providers are `anthropic` (Claude), `openai-codex`
(ChatGPT, for Codex) and `xai` (Grok); `claude`, `codex`, `chatgpt` and
`grok` work as aliases.

Only one sign-in runs at a time. If you leave the Accounts page or close
Settings while a sign-in is open, it keeps waiting for your browser; open
**Accounts** again to see it and finish or cancel it. Starting a sign-in for
another provider from the same window replaces the open one, and a sign-in
left unfinished for 10 minutes is cancelled on its own.

## Your own login (the System login)

When Claude Code or Codex on this computer is already signed in, and no
account is that login yet, the provider shows one line:

> Claude Code on this computer is signed in as you@example.com.
> **Use in Codara** · **Dismiss**

**Use in Codara** adds it as an account with the badge **Your Claude Code
login**. Codara reads only who it is signed in as. It never copies, refreshes
or rewrites that login, so the CLI keeps managing it the way it always has.
Cora does not get a copy either: the card says **Cora isn't connected** until
you click **Connect Cora**, which signs Cora in with its own grant for the
same account. Limits show once Cora is connected.

**Dismiss** hides the line until a different account signs in to the CLI.

## Choosing the Active account

Click **Switch to this account** on an account card, or run:

```sh
cora auth list                          # every account, with a number
cora auth use anthropic "Work Claude"   # or: cora auth use anthropic 2
cora auth use anthropic system          # back to your own Claude Code login
```

This switches Cora and the terminal tool to that account together, in one
click; nothing asks you to close anything. What a switch reaches:

- **Claude Code.** Every Codara terminal on a Codara account runs in one
  Codara-owned slot, and Claude Code reads its login there on every request.
  Running Claude Code sessions switch on their next request
  (`npm run smoke:claude-hotswap` checks this against the installed
  `claude`; it has not been run on macOS yet, where the login sits in the
  Keychain).
- **Codex.** Codex loads its login once when it starts, so each Codex account
  has its own folder. New Codex sessions use the new account. Running ones
  keep theirs.
- **Grok.** New Grok sessions use the new account. Running ones keep theirs.
- **Cora.** New Cora chats use the new account. A chat that is already
  running keeps the account it started with.
- **Your own login.** Codara never writes to your own CLI folder, so it cannot
  swap your login into a running session. Switching to or from the System
  login applies to new sessions.

When a Codara account is Active and your own login is not an account yet,
the provider offers **Use your Claude Code login** (or Codex, or Grok): new
sessions then use the CLI's own login, with no account Active.

### What stays shared

A Codara account's folder links to your own `~/.claude` (or `~/.codex`, or
`~/.grok`) for what is not tied to an account: projects and the `/resume`
list, open sessions, skills, agents, commands, plugins, settings and history.
`/resume` and session pickers therefore show the same sessions inside Codara.
The login and everything account-scoped stay private to the account.

MCP servers that need a sign-in must be connected once in each Codara
account, because that sign-in belongs to the account.

### Pi

Pi panes (the **Pi worker** row in the **+** menu) run the `pi` you installed,
with your own `~/.pi` and whatever you signed in to there. Codara's accounts do
not apply to them, and Cora never reads your `~/.pi`.

## Pi, the engine behind Cora

Cora runs on the Pi coding agent (`@earendil-works/pi-coding-agent`, 0.85.1 or
newer). You can install it yourself:

```sh
npm install -g @earendil-works/pi-coding-agent
```

or with **Install Pi** in Settings, Accounts, which runs that same global npm
install once. Updating Pi is up to you; Codara never updates or removes it.
Until Pi is installed, Cora runs on a Pi build bundled with the app. Either
way, Cora signs in with your Codara accounts, not with the contents of
`~/.pi`.

## Keeping logins fresh

OAuth logins expire and have to be refreshed. Codara refreshes only logins
it owns:

- **A Codara account's two copies stay in step.** Cora's copy and the
  terminal copy hold the same sign-in. Whichever refreshed last holds the
  only valid refresh token, and Codara copies it to the other so both stay
  signed in.
- **Codara is the one refresher of a Claude account.** While Studio runs, it
  renews the Active Claude account shortly before Claude Code would, and Cora
  asks Codara for a fresh token instead of refreshing its own copy. No two
  clients ever race to spend the same refresh token.
- **Your own login is never refreshed by Codara.** The CLI does that itself.
  If an earlier version of Codara had given Cora a copy of it, that copy is
  never refreshed either: when it expires, the card says Cora isn't
  connected, and **Connect Cora** signs Cora in on its own.

## Renaming, reconnecting and removing

The account card's menu has **Rename** and **Remove**, and an expired
account shows **Sign-in expired** with **Reconnect**. The CLI has the same:

```sh
cora auth login anthropic "Work Claude"               # reconnect an expired sign-in
cora auth rename anthropic "Work Claude" "Team Claude"
cora auth remove anthropic "Team Claude"              # asks first; --yes skips the prompt
```

Removing an account asks once. A Codara account's sign-in is deleted from
Codara's folder; a folder a running terminal still uses is deleted when that
terminal exits. Your login outside Codara is not affected. A removed account
stays removed: nothing brings it back except adding it again.

Removing your own login (the System login) from Codara only forgets it.
The login stays as it is, and Codara stops offering it.

## What earlier versions changed

Earlier versions wrote Codara's hooks, the `codara-studio` MCP server and the
Codex notify program into your global Claude Code and Codex config, and moved
the Active account's login into `~/.claude` and `~/.codex`. Codara now passes
all of that on the command line of the sessions it starts (see
[on-your-machine.md](./on-your-machine.md)). On the first start of this
version it removes its old entries from your config, after saving a backup;
Settings, About says where the backup is.

A build that runs with a temporary home, from a temporary folder or from a
git worktree leaves your own config alone, and Settings, About says so and
why: the old entries then stay active until an installed Codara starts. A
Linux AppImage counts as installed even though it runs from a temporary
mount, unless the `.AppImage` file itself sits in a temporary folder. Only
the process running from that mount counts: a build started from one of its
terminals, which inherit the AppImage's environment, does not, and Codara's
terminals no longer carry `APPIMAGE`, `APPDIR`, `OWD` or `ARGV0`.

Every file an account leaves on disk is listed in
[on-your-machine.md](./on-your-machine.md).

## Claude in other terminals

With **Use the Active Claude account in other terminals** on, typing
`claude` in Terminal, iTerm, Windows Terminal, VS Code's terminal or any
other terminal app runs Claude Code with the Active Claude account, the same
way a Codara terminal does, and a switch in Codara reaches those sessions on
their next request. Your own Claude login is never changed: with your own
login active in Codara, with the setting off, or once Codara Studio is
removed, `claude` uses your own login again.

How it works: Codara adds one guarded line to the startup file of each shell
you use (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` on macOS, a fish
`conf.d` file, your PowerShell profile on Windows, Git Bash's `~/.bashrc`).
The line loads a small script from `~/.codarastudio/shell/` only while that
script exists, and the script only acts while the app is still installed.
Each file is backed up to `~/.codarastudio/backups/claude-follow/` before the
first edit; a file kept in a git repository, a signed PowerShell profile and
a PowerShell profile your execution policy would refuse are left alone.
Turning the setting off takes the lines out again, and so does the Windows
uninstaller; on macOS and Linux the line simply does nothing once the app is
gone.

It stays out of the way: it does nothing when you set `CLAUDE_CONFIG_DIR` or
another Claude login variable yourself, when you have your own `claude` alias
or function, inside Codara's own terminals, or in scripts. Command Prompt
(`cmd.exe`) always uses your own login.

While it is on, Codara keeps your MCP servers and the folders you trusted in
step between `~/.claude.json` and the active account, copies your MCP
sign-ins once (a server that rotates its tokens may ask you to sign in to it
once more), and a `/login` typed in one of those terminals becomes an account
in Codara and the Active one.

Only the installed app sets this up. A development build does so only when
started with `CODARA_CLAUDE_FOLLOW_DEV=1`.

