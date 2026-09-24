# Accounts

This page explains how Codara Studio handles your agent sign-ins: what an
account is, how to add one, what the Active account does, what happens when
you switch, and who keeps the logins fresh. It is written for users. The
design behind it, with file references, is in
[architecture.md](./architecture.md#accounts).

## The short version

- An **account** is one sign-in with a provider: Claude, ChatGPT or Grok. One
  sign-in serves both Cora and the matching terminal tool (Claude Code, Codex
  or Grok).
- For each CLI, one account is the **Active** one. Every terminal Codara opens
  uses it, and so do new Cora chats.
- For Claude Code and Codex, switching the Active account works exactly like
  `/login` as another account. Nothing else about your setup changes.
- Pi is separate: Pi panes run your own Pi with your own `~/.pi`.

## Adding an account

Open Settings (Cmd+, on macOS, Ctrl+, elsewhere), go to **Agents**, and click
**+** next to **Accounts**. The first-run guide offers the same sign-in (see
[getting-started.md](./getting-started.md)). From a terminal:

```sh
cora auth add anthropic "Work Claude"
```

The sign-in page opens in your browser and the command finishes in your
terminal. Providers are `anthropic` (Claude), `openai-codex` (ChatGPT, for
Codex) and `xai` (Grok); `claude`, `codex`, `chatgpt` and `grok` work as
aliases.

The first account of each CLI, "Account 1", is simply your own login in that
CLI's usual home. If you were already signed in to Claude Code or Codex before
installing Codara, that login is Account 1.

## Choosing the Active account

Click **Use this account** on an account card, or run:

```sh
cora auth list                          # every account, with a number
cora auth use anthropic "Work Claude"   # or: cora auth use anthropic 2
```

This switches Cora and the terminal tool to that account together. A Cora
chat that is already running keeps the account it started with. A Codex
switch that would close running Codex sessions needs your confirmation, which
the account card asks for; `cora auth use` stops and tells you how many
sessions are open.

### What a switch does in Claude Code and Codex

Claude Code and Codex run every account in your own `~/.claude` and
`~/.codex`, the same homes they use in any other terminal app. Only the
Active account's login lives there; the other accounts' logins wait in a
private store under `~/.codarastudio`. A switch moves only the login, the way
`/login` as another account does:

- MCP sign-ins, settings, chats, the `/resume` list, history and project trust
  all stay, because there is only one copy of each.
- The switch applies everywhere at once, including terminals outside Codara.
- Running Claude Code sessions pick up the new account on their next request.
- Running Codex sessions are closed, after you confirm.

It also works the other way round. If you run `/login` in Claude Code, or
`codex login`, in any terminal and sign in as an account Codara already
knows, that account becomes the Active one in Codara within a minute.

### Grok

Grok keeps a private home per managed account under
`~/.codarastudio/grok-cli/`, with your personal `~/.grok` state linked into
it so your sessions survive a switch. Studio terminals follow the Active Grok
account; a terminal outside Codara keeps using your own `~/.grok`.

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

or with **Install Pi** in Settings, Agents, which runs that same global npm
install once. Updating Pi is up to you; Codara never updates or removes it.
Until Pi is installed, Cora runs on a Pi build bundled with the app. Either
way, Cora signs in with your Codara accounts, not with the contents of
`~/.pi`.

## Keeping logins fresh

OAuth logins expire and have to be refreshed. Two rules keep that safe:

- **Each account's Cora side and CLI side stay in step.** Whichever side
  refreshed last holds the only valid refresh token, and Codara copies it to
  the other side so both stay signed in.
- **Codara is the one refresher of a Claude login.** While Studio runs, it
  renews the Active Claude login shortly before Claude Code would, and Cora
  asks Codara for a fresh token instead of refreshing its own copy. No two
  clients ever race to spend the same refresh token.

## Renaming, reconnecting and removing

The account card has these actions, and so does the CLI:

```sh
cora auth login anthropic "Work Claude"               # reconnect an expired sign-in
cora auth rename anthropic "Work Claude" "Team Claude"
cora auth remove anthropic "Team Claude"              # asks first; --yes skips the prompt
```

Every file an account leaves on disk is listed in
[on-your-machine.md](./on-your-machine.md).
