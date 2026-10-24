# Machines: other computers as extra compute (plan)

Status: plan approved 2026-10-25 (decisions in section 10). Phases 1 and 2
are being built, each as its own PR against `Cora`.

The goal, in Etienne's words: "a way to connect servers or an old computer I
have at home and use them as extra compute from Codara Studio, or even agent
sandboxes, somewhat like t3code does."

## 1. What exists today

Studio already does more of this than it looks:

| Piece | Where | What it gives us |
|---|---|---|
| SSH workspaces | `src/main/remote/connections.ts`, `src/shared/remote.ts` | One multiplexed ssh2 connection per host, keyed by an alias (`ssh://<hostId>/<path>`). SFTP files, exec channels (git, search), shell channels (terminals). Hosts come from `~/.ssh/config` (read-only) or are added by hand. |
| Remote terminals | `doSpawnRemote` in `pty-manager.ts` | A pane in an SSH workspace runs the host's own login shell on an ssh2 PTY channel and runs its startup command after `cd`. |
| Port forwarding | `remote/port-forwarding.ts`, `PortsChip.tsx` | Dev servers on the host appear on `127.0.0.1` here, and `codara_preview_navigate` to `localhost:<port>` works from a remote workspace. |
| Codara Cloud boxes | PR #44 (merged into `main`) | A box is an ordinary `RemoteConnection` whose transport is a ProxyCommand (`codaracloud boxes ssh-proxy`), with its own host key alias. |
| Host keys | `verifyHostKey` in `connections.ts` | Trust on first use, sha256 fingerprint per `host:port` in `~/.codarastudio/spark-known-hosts.json`. A changed key blocks the connection. |
| Local meters | `system-metrics.ts`, `system-metrics-linux.ts`, `SystemMeters.tsx` | CPU, RAM, swap, GPU and per-process detail for this computer. The `/proc` parsers (`parseMeminfo`, `parseProcStatCpu`, `parsePressure`) work on any Linux text, so they can parse a remote host's `/proc` too. |
| Scoped agent socket tokens | `agent-socket-capabilities.ts` | Imported pull request runs already get a token limited to a list of methods. The same mechanism can limit what a remote machine may ask of this computer. |
| Phone relay | `codara-remote-relay`, `remote-access/relay-client.ts` | Blind relay, Noise IK end to end, outbound connections on both sides. A candidate for machines behind NAT, later. |

What is missing, and blocks the goal:

1. **Remote agents are fragile, and one hand-off is blocked.** Agents do
   start in a remote workspace: the "+" menu's Claude worker runs `claude`
   in the host's SSH shell and Studio detects it from its output (checked
   end to end against a container, 2026-10-25). What is missing is item 2
   below, plus the review "send to new agent" hand-off, which stays disabled
   there (commit `0e789c9e`) because its notes file lives on this computer.
2. **Remote terminals die with the connection.** The shell is an ssh2
   channel. Closing Studio, sleeping the laptop or a Wi-Fi drop ends every
   agent on the host. For "extra compute" this is the biggest gap.
3. **Cora refuses remote folders** (`buildPiManagerLaunchPlan`: "Cora runs on
   local folders only for now"), and `worker-diff.ts` returns nothing for
   remote paths.
4. **Remote agents have no Codara tools.** The agent socket listens on
   `127.0.0.1` of this computer, and the per-launch integration
   (`--settings`, `--mcp-config`) points at local files.
5. **No view of machines.** Hosts appear only as workspaces. Nothing shows a
   host's CPU, RAM, disk, load or which agents run there.

## 2. What t3code does (checked against its repo, 2026-10-25)

- **SSH bootstrap.** The desktop app runs a script over `ssh` that installs a
  pinned, self-contained `t3` archive (about 70 MB) into
  `~/.t3/runtime/versions/<ver>/` and starts `t3 serve --host 127.0.0.1`
  under `nohup`. It then opens `ssh -N -L` to that port and talks HTTP and
  WebSocket through it (`packages/ssh/src/tunnel.ts`).
- **Verification is a checksum from the same origin** as the archive
  (`SHA256SUMS`), so it catches corruption, not tampering. No signature.
- **Auth.** The desktop runs `t3 auth pairing create` over SSH to get a
  one-time token. Tokens can be scoped (`terminal:operate`,
  `filesystem:write`, ...) but default to everything.
- **Everything stays on the remote**: projects, provider sign-ins, agent
  work. Provider CLIs must be on the PATH of a non-interactive login shell.
- **Several routes to one machine** (LAN, Tailscale, public URL, its own
  relay), tried in order, re-checked every minute.
- **Load balancing** is off by default, picks a machine for new threads from
  CPU and memory headroom, with per-machine Prefer / Normal / Less often /
  Manual only. Existing threads stay put.
- **Docker Sandboxes** are just SSH hosts (`ssh demo.sbx`). The per-task
  cloud sandbox broker (issue #14793) was proposed and closed, never built.
- **Security**: the docs say it "is not a security boundary". Host key
  checking is whatever the user's `ssh` does.

Sources: [remote-access.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md),
[Docker's T3 page](https://docs.docker.com/ai/sandboxes/integrations/t3-code/),
[issue #14793](https://github.com/pingdotgg/t3code/issues/14793),
[flaviocopes.com/t3-code](https://flaviocopes.com/t3-code/).

What we take: work stays on the machine, a small server on the host that
outlives the connection, sandboxes as ordinary hosts, manual placement first
with "auto" as an opt-in. What we do differently: a **signed** helper that
Studio uploads (the host never downloads code by itself), no listening port
on the host at all, scoped tokens by default instead of everything, and our
own host key confirmation.

## 3. One "Machines" list

A new **Machines** view (Settings, and a compact list in the workspace rail's
footer). Every place compute can come from is one row:

| Kind | How it is reached | Example |
|---|---|---|
| This computer | local | Etienne's laptop, always first |
| SSH machine | ssh2, direct or through `~/.ssh/config` (ProxyJump, ProxyCommand) | `homeserver`, `old-thinkpad`, `etienne@192.168.1.40` |
| Tailscale machine | an SSH machine whose host is a Tailscale name | `nas.tail1234.ts.net` |
| Codara Cloud box | ssh2 over `codaracloud boxes ssh-proxy` (PR #44) | `box/dev-1` |
| Sandbox | a hop through the machine that runs it (section 5) | `sbx/fix-login-142` on `homeserver` |

Each row shows: status (connected, asleep, offline, needs sign-in, key
changed), CPU %, RAM used / total, disk free, load, and **the agents running
there** (Claude Code, Codex, Grok, Pi, with working / needs you / idle, the
same states the panes show). Clicking an agent jumps to its pane.

**How the numbers are read.** One exec per poll, every 10 seconds while the
view is open and every 60 seconds otherwise, never while the window is
hidden. The probe is a short `sh` script reading `/proc`, `df` and
`nproc` (macOS: `sysctl`, `vm_stat`). Measured on this computer: about 5 ms
per run. **Inside a container `/proc` lies**: a probe in a container limited
to 1 CPU and 1 GiB still reported 24 CPUs and 31 GiB, while
`/sys/fs/cgroup/memory.max` said 1073741824 and `cpu.max` said
`100000 100000`. The probe therefore reads cgroup v2 limits first, and the
row shows the limit, not the host's size. The probe also lists which CLIs
are installed (`claude`, `codex`, `grok`, `pi`, `tmux`, `git`, `node`,
`docker`), so the UI can say "Codex is not installed on homeserver" before
you try.

**Adding a machine.** "Add machine" offers:

1. **SSH host or alias.** Pick one from `~/.ssh/config` or type
   `user@host[:port]`. This already exists (`SshManagerDialog.tsx`); it moves
   into the Machines view.
2. **Tailscale name.** The same as 1, with the host field accepting
   `name.tailnet.ts.net` and a hint when Tailscale is not running here. No
   Tailscale code in Studio: it is just a host name that resolves.
3. **Codara Cloud box.** The existing picker from PR #44.
4. **Pair through the relay** (a later option, not planned now; see section 9). For a machine behind NAT
   without Tailscale: install the helper there, run `codara-host pair`, scan
   or type the code in Studio, confirm the short code, same as the phone.

Before the first connect, Studio shows the host key fingerprint and asks
"Is this homeserver?" instead of trusting silently (section 6).

**What gets installed on the machine.**

- **Phase 1 installs nothing.** Studio uses the host's own shell, its own
  agent CLIs and `tmux` when it is there.
- **From phase 3, a small helper, `codara-host`**, in
  `~/.codara/host/<version>/`. It is a single file per platform (Linux x64,
  Linux arm64, macOS arm64), built in CI and **signed with an Ed25519 release
  key**. Studio downloads it on this computer, checks the signature, uploads
  it over SFTP and checks the hash again on the host. The host never fetches
  code from the internet on Studio's behalf. Studio starts it over an exec
  channel; it speaks JSON lines on that channel's stdin and stdout and
  **opens no network port**. It keeps a small daemon (a Unix socket in
  `~/.codara/host/run/`, mode 0600) that owns the agents' PTYs so they
  survive disconnects, streams hook events and stats, and lists running
  agents. It runs as the SSH user, never as root.
- **Updates**: the helper version equals the Studio version. On connect,
  Studio compares, uploads the new one next to the old, and switches on the
  next start. Running agents keep the old daemon until they end; the old
  version is removed once nothing uses it. Two versions at most on disk.
- **Agent CLIs are not installed by Studio.** The row says what is missing
  and offers the official install command to copy, or "Install in a terminal
  on homeserver", which opens a remote pane with the command typed but not
  run.

## 4. Running work on a machine

### 4.1 An agent terminal on a machine

The "+" menu, the pane toolbar and `codara_spawn_terminals` get a **Where**
choice: This computer, or any connected machine. A machine's workspace is
the existing `ssh://<host>/<path>`, so files, git, search, the Ports chip
and browser previews already work as if local.

- **Launch.** Studio runs the machine's own `claude`, `codex`, `grok` or `pi`
  in the remote pane. Phase 1 wraps it in `tmux new-session -A -s
  codara-<paneId>` when tmux exists, so the agent survives Studio closing;
  reopening the pane reattaches. From phase 3 the helper's daemon replaces
  tmux and the requirement goes away.
- **Codara tools for remote agents** (phase 3). Studio opens an SSH *remote*
  forward from a Unix socket on the host
  (`~/.codara/host/run/agent-<id>.sock`, mode 0600) to the agent socket
  here, with a **machine token** minted from `agent-socket-capabilities.ts`
  (section 6 lists its methods). The helper ships a tiny MCP shim that the
  remote Claude Code and Codex get through the same per-launch flags as
  local ones, pointing at remote paths. Hooks write to the host's disk; the
  helper streams them to `hook-watcher.ts` as if they were local files.
- **Turn tracking** already works on remote output (`terminal-agent-notify.ts`
  reads every pane's bytes), so notifications and the rail's states work from
  phase 1, before hooks arrive.

### 4.2 Cora on a machine

Recommended split: **Cora's manager stays on this computer, workers run on
the machine.** The manager is a light Pi process that mostly waits on
models; workers are where CPU, RAM and disk go (builds, tests, installs).
This keeps Cora's memory, accounts and run files on this computer, where
they live today, and makes a machine a place workers run, not a second
Studio.

- A run (or one step) gets a **Run on** setting: This computer, a machine,
  or a fresh sandbox.
- The worker's worktree is made **on the machine** in its own clone of the
  repository (`git worktree add` over exec). The worktree setup service's
  command part runs there too; `plan.ts` already reads only the main
  checkout, which on a machine is the machine's clone.
- The worker's PTY is a remote pane (4.1). Its final report arrives through
  the machine token.
- **Getting the result back.** Studio runs `git fetch` from this computer
  over the same SSH connection (`ssh://homeserver/<repo>` as a temporary
  remote) for the worker's branch. From then on, diff, review and merge are
  the local flows that exist today. Nothing is merged without the same
  review a local worker gets, and a machine marked shared or untrusted never
  gets auto-merge.
- A whole Cora run on the machine (Pi there too) is possible later with the
  helper, but nothing asks for it yet.

### 4.3 Where credentials and subscriptions live

**Sign in on the machine. Studio never copies a login to another machine on
its own.** Each machine keeps the agent CLIs' own sign-ins in its own home
(`~/.claude`, `~/.codex`, ...), exactly as if Etienne had SSHed in and run
them.

- The row shows each CLI's sign-in state (from the probe: the CLI's own
  status command where it has one, otherwise "unknown until first launch").
- "Sign in on homeserver" opens a remote pane running the CLI's login. For
  headless machines: Codex has `codex login --device-auth`, and Claude Code
  prints a URL and accepts a pasted code. Studio's link handling opens the
  URL in the browser here. The login's own localhost callback ports are
  excluded from automatic forwarding today (`port-detect.ts`) and stay so.
- A subscription signed in on two machines is the provider's normal
  multi-device use. Studio's Accounts view shows remote sign-ins as
  "on homeserver", read-only: no switching, no refresh, no hot swap there.
- A later, **explicit** "Use this account on homeserver" could copy one
  managed login, with a clear warning, a per-machine record and Revoke. Not
  in this plan.

## 5. Sandboxes

A sandbox is a **disposable machine for one task**: a container on this
computer or on a machine, created from a repository and branch, removed when
done. It is the safe place for untrusted pull requests, risky installs and
"let the agent run with full permissions".

- **Runtime.** Docker (or Podman) on this computer or on any machine whose
  probe found `docker`. One image, `codara-sandbox` (Ubuntu LTS, git, Node,
  tmux, the helper, a non-root user), built and signed in CI. Limits on
  every sandbox: `--cpus`, `--memory`, `--pids-limit`, no `--privileged`, no
  Docker socket inside, no host mounts except its own volume.
- **How Studio reaches it.** The container runs sshd on its bridge address
  only, with a key pair Studio makes for that sandbox. Studio reaches it with
  a `direct-tcpip` hop through the machine's existing connection, the same
  shape as the Cloud box ProxyCommand. So a sandbox is one more
  `RemoteConnection`, and terminals, files, ports and previews work with no
  new code.
- **Lifecycle.** Create (clone, branch, setup) → running → **idle-stop**
  after 30 minutes with no working agent, no terminal input and no
  forwarded port in use (`docker stop`; the volume stays) → wake on open →
  **Stop** at any time → **Archive** (push the branch if it has a remote,
  save the volume as a tarball on the machine, remove the container) →
  **Delete**, explicit and confirmed, removes the volume.
- **Logins in sandboxes.** Default: none. A sandbox for trusted work can
  mount a per-machine "sandbox logins" volume, opt in per sandbox; a sandbox
  for an imported pull request never gets it.
- **Cloud.** A per-task Codara Cloud box is the cloud version of the same
  thing (`codaracloud boxes create` / sleep / delete). Studio already speaks
  to boxes; what it would cost and who gets it is the business question in
  section 7.

## 6. Security

**Who can do what to whom.**

| Direction | Today (SSH workspaces) | With this plan |
|---|---|---|
| This computer → machine | Anything the SSH user can do: Studio runs shells, git and SFTP as that user. | The same. Recommend a dedicated `codara` user on home servers so agents cannot read the owner's other files. |
| Machine → this computer | Terminal bytes (escape sequences, OSC 52 clipboard writes that `osc52.ts` already limits to visible, typed-into panes, never reads), file contents shown in the editor, web pages through forwarded ports (on `127.0.0.1` here), git refs fetched back. | Plus the **machine token**, and hook events through the helper. Nothing else. |

**The machine token** (phase 3) is a capability from
`agent-socket-capabilities.ts`, one per machine connection, revoked on
disconnect. It allows: report a worker result for an attempt running on that
machine, open terminals and previews **in that machine's own workspaces**,
read and update that workspace's task list and status line, and
notifications. It never allows: local file reads or writes, local
terminals, accounts and logins, Capability Center changes, other
workspaces, or `pane.open`. A machine is never offered **Always** on the
cross-workspace card: a request from a machine's workspace to a local
workspace asks every time, and a machine marked untrusted cannot ask at all.

**Host keys.** Today Studio trusts the first key it sees. Change: on first
connect show the fingerprint and confirm, and accept without asking only if
the same key is already in `~/.ssh/known_hosts` (read, never written). A
changed key stays a hard stop, now with a "This key changed" screen that
shows old and new and a Trust new key button, instead of telling the user to
edit `spark-known-hosts.json`. Cloud boxes keep their alias-keyed store from
PR #44. No SSH agent forwarding, ever (ssh2 does not forward today; keep it
that way).

**Which folders are reachable.** On the machine: whatever its SSH user can
read. Studio does not pretend otherwise; the dedicated user is the real
boundary. On this computer: nothing, except forwarded ports, the machine
token's methods, and git fetches Studio itself starts.

**If a home machine is compromised**, the attacker gets: everything on that
machine, including the agent sign-ins stored there (which is why Studio does
not copy logins around: the damage stays one machine's logins), the ability
to show crafted output in its panes, crafted pages in its previews (a
forwarded port is `localhost` here, so it shares an origin with local dev
apps on the same port number: previews of forwarded ports get their own
browser partition), and the ability to send false worker reports. False
reports are why results come back as git commits through the normal review
and never auto-merge from an untrusted machine. The attacker does not get:
this computer's files, shells, logins, the full agent socket token, or other
workspaces. Revoke a machine in one click: remove it, its token dies, its
host key is forgotten.

**Trust levels.** A machine is **Mine** (default for hosts Etienne adds) or
**Shared** (a server other people can log into, or any sandbox running an
imported pull request). Shared machines get the narrower token above and no
auto-merge.

## 7. Fit with Codara Cloud

| | Home machine / old laptop | Docker sandbox | Codara Cloud box |
|---|---|---|---|
| Who pays for the hardware | the user | the user (it runs on one of their machines) | Codara, recovered through the plan |
| Reach | LAN, Tailscale or plain SSH | through its machine | through platform-api only, never public |
| Always on | if the user leaves it on | idle-stop | sleeps after idle (default 30 min), wakes on connect |
| Isolation | the user's own box | container | gVisor, dedicated nodes |
| In Studio | the same row, the same "Run on" picker, the same agents |||

Studio treats all three the same way, which is the point: one list, one
picker.

**Decided (Etienne, 2026-10-25): using your own machines is free for every
Studio user.** They connect over the LAN, Tailscale or plain SSH, straight
from Studio to the machine, so Codara carries no traffic and runs nothing
for them. Codara Cloud boxes stay the paid option for people with no machine
of their own, or who want one that is isolated and always reachable.
Per-task Cloud sandboxes (a box per Cora worker, created and deleted
automatically) are decided later.

Cost note for that later decision: per-task Cloud sandboxes create and
delete boxes often, and each box home is a Hetzner Volume with a 10 GB
minimum.

## 8. Scheduling

1. **By hand first.** "Run on" defaults to This computer; the last choice is
   remembered per workspace. The picker shows each machine's free RAM and
   load so the choice is informed.
2. **Later, "Anywhere with room"** as an opt-in choice, like t3code's: pick
   the machine with the most free RAM above a floor of about 1 GiB per agent
   (Claude Code sessions measured 230 to 490 MiB in the Boxes decision
   record) and load below its CPU count, preferring This computer when it has
   room. Per-machine Prefer / Normal / Manual only. The choice is pinned when
   made; nothing moves a running agent.
3. Cora's planner can use the same rule when a run says "Run on: anywhere".

## 9. Build plan

Every phase lands as its own PR against `Cora`, behind a `machines`
preference until phase 2 ships.

| Phase | Delivers | Size | Tests |
|---|---|---|---|
| **1. Agents on an SSH host** | The "+" menu and `codara_spawn_terminals` start Claude Code, Codex, Grok or Pi in a remote workspace with the host's own CLI and sign-in, inside tmux when present, reattached after reconnect or restart. A clear message when a CLI is missing. No Codara tools on remote agents yet. The review "send to new agent" hand-off and a signed-out check move later. Built in #59. | Small: 1 PR, about 2 days | Unit: the generated launch, attach, probe and kill lines run under `/bin/sh` against fake `tmux` and `claude`; reconnects against fake ssh2 channels; the wiring in the real `pty-manager.ts`. A Playwright spec against a real sshd and tmux in a throwaway Ubuntu container (fake `claude` that prints the real banner) proves launch, turn detection, quit and reattach, a dropped connection, and close. |
| **2. Machines list** | The Machines view: This computer plus SSH hosts and Cloud boxes, with status, CPU, RAM, disk, load and agents; Add machine with host key confirmation; "Where" picker in the "+" menu; the cgroup-aware probe. Built in #62; the compact rail list and background polling move later, and the preference stays off by default until Etienne decides. | Medium: 1 to 2 PRs, about 4 days | Unit: probe parser on recorded Linux, macOS and container outputs (including the cgroup case above); host key confirm and change flows. e2e (headless Playwright): add a machine pointing at the sshd container, see its numbers, start an agent from the picker. |
| **3. codara-host helper and Codara tools on machines** | Signed helper upload and update, persistent PTYs without tmux, hook events, the machine token over a remote-forwarded Unix socket, the MCP shim, Accounts shows remote sign-ins read-only. | Large: 3 PRs, about 2 weeks | Unit: signature check refuses a tampered file; token allowlist refuses every local-only method (a table test over all socket methods); daemon survives channel close. Container smoke: upload, start, kill the connection, reconnect, agent still running; a remote Claude stub calls a Codara tool through the socket. |
| **4. Cora workers on a machine** | "Run on" for runs and steps, remote worktrees and setup, remote worker PTYs, reports through the machine token, `git fetch` of results, worker diff for remote attempts. | Large: 2 to 3 PRs, about 2 weeks | Extend `test-step-lifecycle` and `test-loom-steps` with a fake remote transport; container smoke: a two-step run with one worker on the container, result fetched and reviewed. |
| **5. Sandboxes** | Docker sandboxes on this computer or a machine, the `codara-sandbox` image, direct-tcpip hop, idle-stop, stop, archive, delete; imported pull request runs can choose a sandbox. | Medium to large: 2 PRs, about 1 week | Container-in-container is avoided: tests run the sandbox on this computer's Docker headless. Lifecycle state machine unit tests; smoke: create, idle-stop after a shortened timeout, wake, archive, delete. |
| **6. Anywhere with room** | Opt-in automatic placement for new agents and Cora steps. | Small: 1 PR, about 2 days | Unit: placement rule over recorded machine snapshots. |
| Later | Relay pairing for NAT machines without Tailscale (see below); per-task Cloud box sandboxes (decided later); a whole Cora run on a machine. | | |

**Later option: relay pairing on Codara Cloud.** For a machine behind NAT
with no Tailscale, the helper could pair through a relay like the phone's
(outbound connections on both sides, Noise IK end to end). Today's relay is
sized and capped for phones. If it is built, it could run on Codara Cloud,
which has large unused egress: Hetzner includes 20 TB of traffic per server,
then 1 EUR per TB. Not planned now: Tailscale and SSH cover the case.

No phase touches Etienne's real servers or `~/.ssh/config`: every test and
smoke uses a throwaway sshd container and a temporary Codara home.

## 10. Decisions (Etienne, 2026-10-25)

1. **First build: phases 1 and 2** (agents on an SSH host, then the
   Machines list), each as its own PR against `Cora`, behind the `machines`
   preference until phase 2 ships.
2. **Using your own machines is free for every Studio user**, over the LAN,
   Tailscale or plain SSH, so Codara carries no traffic (section 7).
   Per-task Cloud sandboxes are decided later.
3. **Machines behind NAT: Tailscale and SSH only for now.** Relay pairing
   stays a later option, possibly hosted on Codara Cloud (section 9).
