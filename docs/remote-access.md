# Remote Access design

Mobile companion apps (iOS and Android) connect to a user's running Codara
Studio, with no Codara-hosted infrastructure on the happy path. This document
is the source of truth for the security model and the phases. The iOS app
exists and its original pairing path has been exercised (see phase 2 below);
the expanded workspace, Explorer, Source Control, Cora, and shared-terminal
work on the current feature branches still needs a physical-phone end-to-end
pass. Android does not exist yet.

Reachability today: **LAN only**. "From anywhere" is the design goal, not what
ships. The desktop implements both the LAN rung and the DHT rung and does
announce itself on the DHT, but the iOS app never dials it: `enableDht`
defaults to false in both `src/lib/remote/create-transport.ts` and
`worklet-transport.ts` and nothing sets it true. The worklet's ladder planner
also enables that rung only in `session` mode, so pairing could not use it
even if the flag were flipped. Phone and computer must therefore be on the
same network, for pairing and for sessions alike. Connecting over the internet
is the next milestone and is **not** shipped.

Even once the phone does dial it, the DHT rung is a hole punch, not a
promise. When both sides sit behind symmetric or carrier-grade NAT with UDP
blocked it cannot form a path, and there is no relay yet (rung 4 is phase 3),
so the phone simply cannot reach the computer. In that case remote access is
unavailable until either side is on a friendlier network or the relay ships.
Do not read the "from anywhere" language below as a promise for those
networks.

## Goals

- A phone can reach the user's computer from another network (5G, hotel
  wifi), as long as the computer runs Codara Studio, has internet access, and
  a NAT path can actually be formed. This is the goal, not the state of the
  code: today the phone dials the LAN rung only (see "Reachability today"
  above), and once it does dial the others, symmetric/CGNAT with UDP blocked
  and no relay still leaves it unreachable.
- Zero Codara-hosted infrastructure for the common case. The project is open
  source; users must not depend on our servers to use their own machines.
- End to end encryption always. No intermediary (DHT node, relay, ISP) can
  read or inject traffic, ever.
- A paired phone is a fully trusted client (it can create terminals, which is
  remote code execution by design), so pairing and revocation are the real
  security boundary and must be airtight.

## Non-goals

- No accounts, no cloud identity. Trust is between two devices only.
- No web dashboard. Clients are the mobile apps and a test client script.
- Multi-user sharing of one computer is out of scope for now.

## Connection ladder

Each rung is tried in order; the first that works wins. This is the target
ladder. The phone dials rung 1 only today, and rung 2 is not implemented on
either side (see "Reachability today" above).

1. Same LAN: direct connection to the computer's local address.
2. Direct WAN: the computer auto-opens a port via UPnP or NAT-PMP and
   learns its public endpoint. Works for most home routers.
3. Hole punch: both sides use the DHT to coordinate a direct connection
   through their NATs.
4. Relay (phase 3): a small, blind, self-hostable relay forwards encrypted
   frames. Codara Cloud hosts the default instance. The relay never holds
   keys and never sees plaintext.

## Identity and pairing

- Each device (computer and phone) has a long-lived Ed25519 identity keypair,
  generated on first use. The computer stores its keys under
  `~/.Codara/remote/`, readable by the main process only. The renderer's fs
  sandbox must never expose this directory (it already only allows the
  `memory/` subdirectory of the Codara home; keep it that way).
- Pairing happens on the same wifi via QR code. The computer displays a QR
  containing its public key, LAN endpoint, and a one-time pairing secret with
  a short expiry (2 minutes). The phone connects over the LAN, proves
  knowledge of the secret, and, after the desktop user approves the request
  (see "Pairing exchange" below), the two devices exchange and pin each
  other's public keys. The secret is single-use and never leaves the LAN, and
  a pairing peer is accepted only from a local (loopback / private /
  link-local) address, so "same wifi" is enforced, not just assumed.
- The computer keeps a paired-devices list (public key, display name, added
  date, last seen). Revoking a device removes its key; existing sessions from
  that key are terminated immediately.

## Transport security

- No hand-rolled cryptographic protocols. Use a vetted Noise implementation.
  Primary candidate: the Hyperswarm stack (hyperdht/hyperswarm), which
  provides DHT discovery, hole punching, and Noise-encrypted streams keyed by
  Ed25519-style public keys, with a firewall hook to accept only allowlisted
  peers. If it proves unsuitable, fall back to a maintained Noise_IK
  implementation over our own transport; primitives from audited libraries
  (libsodium or noble) only.
- The listener is silent: an unauthenticated peer receives no banner, no
  version, no error, nothing. Connections that do not complete a handshake
  proving possession of a paired public key are dropped without response.
- Key pinning both ways. The phone verifies the computer's key from pairing;
  the computer accepts only keys in its paired list. There is no trust on
  first use after pairing.

## Discovery (serverless phone book)

- The computer publishes a small signed record (current endpoints, timestamp)
  addressed by its public key, encrypted so only paired devices can read it.
  With Hyperswarm this is implicit (peers find each other by public key on
  the DHT). If we ever need an explicit record store, use PKARR-style signed
  mutable records on the mainline DHT.
- The phone resolves the computer by public key, then climbs the ladder. Not
  exercised yet: resolving by key is the DHT rung, and the current iOS
  implementation never dials it, so today it reaches the computer by the LAN
  addresses the QR carried instead.

## RPC surface (v0)

A versioned, length-prefixed JSON-RPC runs over the encrypted stream. The
current method table is:

- connection: `hello` (protocol negotiation and device info), `ping`;
- workspaces: `workspaces.list`, `directories.list`, `workspaces.add`;
- project files: `files.list`, `files.read`, `files.create`, `files.rename`,
  `files.move`, `files.delete`;
- read-only source control: `git.status`, `git.log`, `git.commitDetail`;
- Cora: `cora.history`, `cora.get`, `cora.send`;
- terminals: `terminal.create`, `terminal.write`, `terminal.resize`,
  `terminal.close`, plus server-pushed `terminal.data` and `terminal.exit`
  events.

The remote module is a client of bounded main-process service adapters, not a
generic renderer IPC or filesystem proxy:

- `workspaces.list` returns local workspaces only, including their Studio
  color and Git branch when available. SSH workspaces are excluded.
- `directories.list` is a directory-only browser rooted at the computer
  user's home directory. `workspaces.add` accepts only an existing directory
  inside that same canonical root, deduplicates an existing workspace, and
  otherwise persists a normal Studio workspace with a Studio palette color.
- Every file method takes a workspace id and workspace-relative path. Reads
  reject traversal and symbolic-link components. Mutations accept only a
  validated leaf name or an existing destination folder; they cannot change
  the workspace root, cross the workspace boundary, enter Explorer-hidden
  metadata/generated trees, follow symlinks, or overwrite an existing entry.
  Creates are exclusive and mutations are serialized per workspace. A delete
  uses the computer's Trash, matching Studio's local Explorer, so the action
  remains recoverable after the phone's destructive confirmation. File
  content editing is not part of v0. Explorer listings omit Studio's
  heavyweight generated directories (`.git`, `node_modules`, `out`, `dist`,
  `build`, `.next`, `.turbo`, and `coverage`).
- `git.status` reports branch/upstream/divergence plus staged, unstaged, and
  conflicted paths. `git.log` returns bounded commit summaries and
  `git.commitDetail` returns bounded metadata and changed-file statistics for
  a hexadecimal commit hash. All three are read-only: stage, discard, commit,
  checkout, pull, and push are not remote methods.
- Cora methods expose purpose-built, bounded summaries and message DTOs rather
  than the full orchestration store. Omitting `runId` from `cora.send` starts a
  new run; including it continues that workspace-owned run (or answers its
  current blocking question). `clientMessageId` is required as a stable retry
  key.
- `terminal.create` accepts a server-owned `shell`, `claude`, or `codex`
  profile, never an arbitrary command. It creates one renderer-owned Studio
  terminal pane that the phone and desktop share. The desktop chooses the
  Claude/Codex launch command.

These inspection guards reduce accidental exposure and keep responses
bounded. They do not make a paired phone untrusted: an interactive terminal is
still remote code execution by design and can access everything the desktop
user can access after it starts.

## Storage

`~/.Codara/remote/`:
- `identity.json` (0600): the computer's keypair.
- `paired-devices.json`: pinned public keys and metadata.
- Never readable by the renderer. Never synced, never logged.

Both files are written with the same hardened path: content is staged to a
randomized, exclusive-create, no-follow temp file (so a pre-planted symlink
at a predictable temp name cannot redirect the write), fsynced, renamed into
place, and the directory is fsynced afterwards, so the write survives a power
loss. The `remote/` directory itself is checked: if it is a symlink, the code
fails closed rather than writing key material and trust state through it.

## Phase 1 as built

The Studio foundation was built in the remote-access feature work. The
hardening and expanded application surface described here remain on the
current feature branch; nothing in this section implies a merge or release.
What follows records the decisions a reader of the sections above would
otherwise have to infer from the code.

### Transport: Hyperswarm, both rungs

We took the primary candidate. `sodium-native` and `udx-native` ship N-API
prebuilds that load unmodified under this repo's Electron, so no native
rebuild step was needed (they are listed in `asarUnpack` because native
binaries cannot load from inside the asar archive; they are also the only two
addons in this tree that actually `dlopen` under Node, so the list is
complete, and the `bare-*` packages that ship prebuilds alongside them are
Bare-runtime artifacts that Electron never loads).

**The packages this module imports must stay in `dependencies`, and that is
load-bearing, not hygiene.** `electron.vite.config.ts` builds main and preload
with `externalizeDepsPlugin()`, whose rule is exactly
`Object.keys(pkg.dependencies)`: a declared package stays an external
`require(...)` resolved from `node_modules` at runtime, and anything else is
inlined into `out/main/chunks`. Inlining a native addon is fatal, because its
resolver then looks for the prebuilt `.node` next to the CHUNK and finds
nothing. `hyperdht`, `@hyperswarm/secret-stream` and `sodium-native` were
imported here while being declared nowhere, reachable only transitively
through `hyperswarm`, which this code has never imported. So from the first
commit of the feature (1767c9c) until 732f18e, the toggle in Settings could
not start the listener at all: `remoteAccess:setEnabled` rejected with
`Cannot find addon '.'`, which the panel rendered as a red error line under a
switch still reading "Turn on". No QR, no pairing, no way to reach that code
from the UI. The feature ran only under `scripts/remote-access-e2e.mjs`,
which marks those same three modules external by hand, which is precisely why
no script-based test noticed; the first thing to catch it was the UI e2e spec
that drives the built app. `npm run test:declared-deps` now fails when any
main-process or preload import is missing from `dependencies`.

Two rungs share one identity keypair:

- **Direct TCP** (LAN, and WAN wherever the router already forwards): a
  plain `net.Server` whose every connection is wrapped in
  `@hyperswarm/secret-stream` with the **IK** handshake pattern. The
  default pattern in that library is XX, which authenticates nobody in
  advance; IK is what makes the initiator prove it already knows our static
  key. Production derives four ordered port candidates from the persistent
  computer public key and binds the first available one. Candidate zero is
  byte-for-byte the former single derived port, preserving existing pairings;
  `EADDRINUSE` alone advances to the next candidate, while any other bind error
  fails closed. The QR advertises the port actually bound. A session dial tries
  its recorded QR port first on every stored LAN address and then the complete
  derived candidate sequence, so an old ephemeral pairing record and a
  collision-driven port change both recover without re-pairing. Pairing itself
  uses only the exact fresh QR port. These endpoints are discovery hints, not
  trust: every attempt still has to complete Noise IK against the full pinned
  computer key. Test/harness callers may explicitly request a port, including
  zero for an OS-assigned ephemeral port; that exact override never enters the
  candidate fallback path.
- **DHT**: a `hyperdht` server announced under the same keypair, with the
  `firewall` hook returning "block" for any key not in the paired list, so
  an unknown key cannot complete a connection at all.

Both rungs converge on the same post-handshake router, and the silent
listener rule holds structurally: the Noise responder never speaks first, so
a port scanner reads zero bytes, and an unknown key after handshake is
either a pairing candidate (only while a pairing window is open) or gets its
stream destroyed with nothing written.

The phone keeps retrying availability failures (`closed` and `unreachable`)
with capped exponential backoff. A foreground or network-available hint only
wakes a retry while the transport is already disconnected; it never replaces
a healthy session or overlaps an in-flight dial, and simultaneous hints
coalesce. A Bare worklet `resume` is stronger evidence: BareKit confirms the
helper was suspended and therefore lost its socket, so that signal may
supersede the stale session/dial exactly once. Explicit disconnect, unpair,
desktop revocation, and protocol rejection disable the retry loop.

To be precise about what "silence" does and does not cover: no APPLICATION
byte ever reaches an unpaired peer, and a revoked device is treated exactly
like a key we have never seen. But our static public key is not a secret (it
appears in every QR code we display), and Noise IK's responder will complete
a handshake with anyone who presents it. So to a party that already knows
the computer's key, the listener is a presence oracle: they learn something
is running, and nothing more. Hiding presence from that party would need a
pre-shared obfuscation secret, which is out of scope for phase 1.

### Pre-authentication resource limits

An accepted socket costs memory before anyone has authenticated: the Noise
framing sizes its receive buffer from a 24-bit length the peer declares in
its first three bytes, so four bytes of attacker input reserve about 16 MiB.
That allocation happens inside the transport library and cannot be undone
from above, so the listener bounds the blast radius instead. Crucially,
completing the IK handshake proves nothing about trust: our responder key is
not secret (it is in every QR and derivable on the DHT topic), so anyone can
complete IK with a self-generated key. So the accounting keeps a socket
inside a bounded pre-authorization budget until it is actually authorized (a
known paired key, or a successful pairing), never merely IK-complete:

- at most 8 sockets that have not yet completed the handshake, refused
  silently beyond that;
- a 5 second handshake deadline on that phase, after which a socket that has
  not completed IK is destroyed (covering both the peer that goes silent and
  the one that dribbles bytes to look active);
- a separate, smaller budget for sockets that completed IK but are NOT
  authorized: at most 4 at once, each on a short deadline, and only ever
  populated while a pairing window is open (a completed-IK stranger with no
  pairing window is dropped at once). Once a candidate proves the pairing
  secret its remaining lifetime passes to the pairing-approval window
  instead;
- 64 total accepted sockets;
- TCP keepalive rather than a wall-clock idle timeout on ESTABLISHED
  sessions, but only after a socket is authorized, so a paired phone may
  idle for hours with a terminal open while an unauthenticated one never
  gets the long leash;
- shutdown destroys tracked sockets itself and bounds its wait, because
  `net.Server.close()` on its own waits for every accepted connection to
  end, and a single silent peer would otherwise hold the listener, the DHT
  announce, the status update, and the whole enable/disable lifecycle open
  indefinitely.

The unauthenticated allocation an attacker can reach is therefore bounded by
those two budgets together: at most (8 + 4) x 16 MiB, roughly 192 MiB, and
only the IK-unauthorized part is reachable at all, and only during a pairing
window. It is NOT the ~1 GiB the 64-socket server cap would otherwise imply,
because an unauthorized socket can never occupy one of those 64 slots for
long. The accepted cost is that a handful of simultaneous hostile sockets can
delay a legitimate pairing by a few seconds.

### DHT rung backpressure, and its limits

The caps above are TCP-rung caps. On the DHT rung the only point at which we
can refuse a peer before its handshake is hyperdht's `firewall` hook, and
that is the only place any of this is enforceable from our side:

- the firewall rejects an unknown key outright, before a connection can
  complete;
- it rate-limits the connection attempts it ACCEPTS from paired keys, so a
  compromised paired device cannot drive an unbounded storm of accepted
  handshakes (a legitimate phone that trips the limit retries and gets in on
  the next window);
- the connection handler caps concurrent established DHT connections, under
  the per-device and global session caps below.

What we cannot bound is everything hyperdht does BEFORE the firewall hook:
the holepunch coordination, and the roughly ten seconds of timers a rejected
attempt leaves inside the library per attempt. Anyone who knows the public
key can drive that from the internet, and it lives inside hyperdht, not our
code. This is an honest limit of taking the Hyperswarm stack, not something
the caps above close.

Concurrent sessions are capped per device (4) and globally (16, refusing
beyond that). Without those caps the 8-terminals-per-connection limit bounded
nothing, since a device could simply open more connections.

The per-device eviction rule is deliberately careful about liveness, because
a passively recorded IK first flight can be replayed on a fresh socket: it
completes the handshake and reports the paired device's key, but the attacker
cannot derive the session keys, so it can never send a valid `hello`. A
newly accepted session is therefore "unproven" until a valid hello completes.
When the per-device cap is hit, we evict an UNPROVEN incumbent (a phantom
replay, or a stalled peer) in preference to a proven, healthy one, and if
every incumbent is proven we refuse the unproven newcomer rather than evict a
live session. So four replays can no longer knock the real phone's live
session offline. A hello deadline reaps any session that authenticates but
never speaks, so phantom replays do not linger. The cost, versus the older
"evict the oldest" rule, is that a phone reconnecting while it genuinely holds
four proven live sessions and one socket is silently dead is refused until
that dead socket is reaped by TCP keepalive; in practice a phone holds a
single session, so the cap is rarely reached at all.

Every outbound frame respects socket backpressure, replies and events alike,
not just the terminal firehose. When the peer stops draining, the pty is
paused at the OS level (a terminal created while already paused is born
paused, so its opening burst is held at the pty rather than dropped), and for
a handle that cannot pause, queued terminal output past 1 MiB is dropped
rather than buffered. Replies cannot be dropped (the peer is waiting on
them), so if a peer keeps issuing requests while never reading our answers,
the total unwritten backlog is bounded: past a hard ceiling the session is
closed rather than allowed to grow the main process without limit. Losing
scrollback to a phone that cannot keep up is recoverable; unbounded growth in
the main process is not.

UPnP / NAT-PMP (rung 2 of the ladder) is **not** implemented in phase 1. The
DHT rung already covers off-LAN reachability, and a port mapping only widens
the exposed surface. The rung stays in the ladder above for phase 3.

### Pairing exchange

The QR payload matches the phone app's parser exactly:
`{ v: 1, pk, addrs, port, secret, iat, name? }`, where `pk` is canonical
padded standard base64 of the 32-byte key, `secret` decodes to 32 bytes, and
`iat` is always present so the phone can enforce the two minute window.

Over the encrypted stream the phone then sends one frame, using the same
length-prefixed JSON framing as the RPC:

```
-> { "t": "pair", "secret": "<base64 from the QR>", "name": "iPhone 17" }
<- { "t": "paired", "name": "<computer display name>" }
```

A wrong, expired, or already-used secret gets no reply at all, only a closed
stream. The secret is compared in constant time and is consumed on first
correct use.

Two properties this exchange now actually enforces, rather than merely
implies:

- **Same network.** The pairing server binds 0.0.0.0, but a pairing
  candidate is accepted only when its remote address is loopback, RFC1918
  private, or link-local; a routable (off-LAN, or VPN-public) address is
  refused silently. The QR likewise advertises only addresses in those
  ranges. Pairing therefore cannot be driven from off the local network,
  which is the property the modal's "same wifi" copy promises. A VPN address
  that is publicly routable is refused for the same reason, so pairing over a
  VPN does not work by design. The phone reinforces this from its own side:
  its ladder planner never enables the DHT rung in `pair` mode, so both ends
  restrict pairing to the LAN independently.
- **Explicit approval, not first-bearer-wins.** Proving the secret no longer
  silently trusts the device. It parks the request in a pending-approval state
  and waits (60 seconds, `PAIRING_APPROVAL_TIMEOUT_MS`) for a human to press
  Approve or Deny in the pairing modal. The device is written to the trust
  store only on an explicit approve. A deny, or the timeout, refuses with a
  clean stream close that the phone reads as a refusal rather than a hang.

  **The fingerprint comparison is the defense, and it is only as good as the
  user performing it.** The desktop shows two things about the waiting device,
  and they have very different provenance. The display name is whatever the
  device asked to be called: attacker-controlled, sanitized but not
  trustworthy. The fingerprint is computed by the desktop from
  `stream.remotePublicKey`, the key the peer actually authenticated with in
  the live Noise handshake, so it cannot be self-reported or spoofed without
  possessing the matching secret key. Both ends render that key identically,
  its leading eight bytes as uppercase hex in groups of four: the desktop in
  `keyFingerprint` (`identity.ts`), the phone in `formatKeyShortForm`
  (`codara-mobile/src/lib/remote/format.ts`), which is why the phone's confirm
  screen says to check that the key the computer shows matches "This phone's
  key" shown below it. Comparing those two strings is what stops the user
  approving a different device that reached the prompt first. Consuming the
  secret at presentation time means a racing device cannot also redeem it; if
  the racing device is the one that reaches the prompt, the user sees a
  fingerprint that does not match their phone and denies.

  The wire format is unchanged: the phone sends the same pair request and
  simply waits longer for the reply.

### RPC v0 application contract and limits

The desktop definitions in `src/main/remote-access/rpc.ts` and the mobile
definitions in `codara-mobile/src/lib/remote/types.ts` now cover the same
method and event table. Matching TypeScript shapes and test harnesses are not
evidence of a physical-phone round trip; the expanded surface still needs
that end-to-end pass.

The principal DTOs are deliberately smaller than the desktop's internal
models:

- A workspace carries `id`, `name`, absolute display-only `path`, optional
  `color`, and optional `branch`. `sessionCount` and `lastActiveAt` remain
  optional compatibility fields and are not currently populated. The mobile
  app keeps an explicit selected workspace; it does not silently bind every
  screen to the first item returned.
- The home-directory browser returns its canonical `rootPath`, current path,
  nullable parent, and directory entries only. It never returns files and
  never permits navigation above the home root.
- Explorer entries carry a workspace-relative slash-separated path, name,
  directory flag, and optional extension. `files.read` returns UTF-8 text,
  byte size, and modification time. Binary files and symbolic-link paths are
  refused. Create, rename, and move return the resulting Explorer entry;
  delete returns the deleted relative path and its parent so the phone can
  refresh the right tree.
- Git status carries `isRepo`, branch/detached state, optional upstream,
  ahead/behind counts, staged and unstaged path/status lists, and a conflict
  flag. Git log rows add hashes, subject, author, relative date, refs, parents,
  and current-HEAD state. Commit detail adds the message body, author email,
  ISO date, and bounded changed-file status/addition/deletion counts. These
  are snapshots, not mutation APIs.
- Cora history returns run summaries (`id`, workspace, title, status,
  timestamps, message count, optional last message, and active-worker count).
  `cora.get` and `cora.send` return the summary plus a bounded human-message
  timeline. They do not expose the full run store, worker prompts, transcripts,
  or raw orchestration event log. There is no Cora push stream in v0; the
  mobile screen refreshes bounded snapshots after sends and while viewing a
  run.

Terminal creation is shared with the desktop renderer rather than spawning an
invisible second PTY:

- `terminal.create` takes `workspaceId`, integer `cols`/`rows`, optional
  `cwd` canonically constrained to the workspace, optional title, and a profile
  of `shell`, `claude`, or `codex`. The profile is an allowlist; the desktop
  owns the launch commands and the phone cannot smuggle an arbitrary autorun
  string.
- The renderer creates a normal background terminal pane without stealing
  desktop focus. Main taps that same pane's PTY for the encrypted phone
  stream. The response includes its opaque `terminalId` and, when available,
  the renderer `desktopTabId` and resolved title.
- The phone origin is stamped from the authenticated pairing-store device
  identity, never from `hello.device` or a phone-supplied field. Renderer
  ownership lives on the terminal leaf so it follows that pane through tab
  moves and detaches. A tab containing such a leaf shows the monoline phone
  badge and names its device in the tooltip; it does not reuse the amber
  background-agent tint. Origin is runtime-only and is stripped before cold
  hydration, because a relaunched shell is no longer the phone-owned PTY.
- The authenticated RPC session remains the lifecycle owner. Phone close,
  stream disconnect, or device revocation closes its shared PTYs and desktop
  terminal surfaces. A natural process exit sends `terminal.exit` first, then
  removes the exact phone-owned Studio pane wherever the desktop user moved
  it; the mobile keeps its ended session entry until the user closes it.
  Opaque UUID-style terminal ids are valid only in their owning session and
  are not reusable after reconnect.
- PTY output can begin while the renderer bridge is still creating the tab.
  Early output is recovered from bounded PTY tail history and buffered by the
  RPC session. The successful `terminal.create` response is always written
  before the first `terminal.data` event for that id, so the phone never sees
  output for a terminal it cannot identify. A process that exits before
  registration produces a create error instead of a dead session.
- `terminal.resize` remains in the protocol and validates dimensions as
  integers from 2 through 1000. For a phone-origin pane, the phone's grid is
  authoritative: production spawns both the Studio xterm and PTY at the
  requested columns/rows, and later resize RPCs update both before the TUI's
  next repaint. The Studio xterm remains visible and interactive, but FitAddon
  and its ResizeObserver do not take geometry ownership for that pane, so the
  desktop container and phone viewport cannot fight.

Current application payload limits:

- collection responses share a roughly 384 KiB JSON budget, below the frame
  ceiling: at most 200 workspaces, 500 directory-picker entries, 750 Explorer
  entries, 100 Git log commits, 500 changed files in one commit detail, 50 Cora
  run summaries, and 200 Cora messages;
- `files.read` accepts regular UTF-8 text files up to 384 KiB;
- commit subjects, refs, authors, paths, and errors have per-field byte caps;
  a commit body is capped at 32 KiB and the whole response still shares the
  collection budget;
- a Cora input message is at most 32 KiB, `clientMessageId` at most 256 UTF-8
  bytes, each returned message is truncated to 16 KiB, and the run must belong
  to the supplied workspace;
- at most 32 asynchronous RPC requests may be in flight per connection;
- at most 8 live or in-flight terminal creates per connection; terminal
  bootstrap buffering is capped at 256 KiB and individual `terminal.data`
  chunks at 128 KiB;
- slow-peer terminal output that cannot be paused is capped at 1 MiB, and the
  total unwritten response/event backlog closes the session above 4 MiB;
- sessions remain capped at 4 per paired device and 16 globally.

Framing and containment limits remain security-relevant:

- Frames use a 4-byte big-endian unsigned length followed by UTF-8 JSON.
  Inbound or outbound payloads above 1 MiB are rejected rather than buffered
  or written. The decoder checks the declared length before copying the body
  and stores fragmented input as chunk views, keeping byte-at-a-time delivery
  linear.
- One decrypted push may contain at most 1024 complete frames; exceeding that
  cap is fatal, like an oversized frame.
- `hello` must be the first call. Anything else before it answers
  `not-connected`.
- Home browsing/addition canonicalizes both root and target and requires the
  target to remain inside the home root; the directory browser omits symbolic
  link entries. Workspace file paths must additionally be relative, remain
  inside the workspace by path segment, exist, and contain no symbolic-link
  component. Where the platform exposes `O_NOFOLLOW`, `files.read` also uses it
  for the final open; every platform validates the opened handle as a regular
  file before the bounded read.
- File mutation names are single portable leaf names (byte-capped, with
  separators, controls, Windows-reserved names, trailing dot/space, and hidden
  Explorer roots rejected). Create uses exclusive-open/no-follow semantics;
  rename and move preflight destination collisions and never intentionally
  clobber; root, traversal, symlink, special-file, and move-into-descendant
  attempts are rejected. The per-workspace serial queue prevents two phone
  mutations from racing each other.
- `terminal.create` applies the same canonical workspace containment to its
  starting `cwd`. This constrains where the shell starts, not where it may go
  afterwards: a paired device is fully trusted and the interactive shell may
  `cd` anywhere the desktop user can access.

### Trust model notes

Three notes on where this feature sits in the app's trust model, recorded so
they are choices rather than surprises:

- Every `remoteAccess:*` channel is privileged, and all of them are gated by
  default. IPC is no longer allowlist-by-exception: about 200 channels,
  including these, are registered through a `handle()` wrapper that runs
  `requireTrustedSender` before the listener ever sees the call, so a new
  channel cannot land ungated by omission (`npm run test:ipc-gate` fails the
  build if a raw `ipcMain.handle` appears). Trust is two independent
  properties: the sender must be the main window's CURRENT `mainFrame` object,
  re-read per call, which rejects subframes and `<webview>` guests without
  relying on any string; and the document in that frame must have arrived by a
  COMMITTED navigation the allowlist accepted. That second flag is maintained
  from `did-navigate` / `did-frame-navigate` only, never from
  `did-navigate-in-page`. The earlier check read the frame's URL, which is
  renderer-writable: `history.pushState` rewrites it with no navigation, so a
  compromised renderer could forge a trusted-looking URL and reach every gated
  channel. Reading the committed-navigation result instead of a live URL is
  what closes that.
- A compromised renderer that is still the trusted main frame can nevertheless
  enable remote access and read a pairing QR payload, and therefore its
  one-time secret, over IPC. The gate above is about which sender may call,
  not about restraining the real renderer, which can already spawn terminals
  and read workspace files; the renderer is not a security boundary against
  itself. Key material is still never exposed: the identity secret key stays
  in the main process and is not reachable over any channel.
- Status and pairing-state pushes fan out to every live `webContents`,
  including preview tabs. Those payloads carry only connection state,
  device display names, and short key prefixes, never key material or
  pairing secrets, so the fanout leaks nothing a preview page could use.

### Revocation

Revoking removes the key from `paired-devices.json` and destroys every live
`RpcSession` for that key in the same tick, which closes that session's
shared PTYs and their visible desktop terminal surfaces. A revoked device's
next connection attempt is met with the same silence as any unknown key.

Revocation is durable, and it is deliberately the last word on disk. The
trust file has two writers: the authoritative one (pairing and revoking) and
an asynchronous cosmetic one (the coalesced last-seen flush). Without care
the second can undo the first, which would let a revoked device be
re-authorized on the next launch.

The guarantee is: **at no point after `revokeDevice` resolves, including
across a crash at any instant, does `paired-devices.json` contain the
revoked device.** `revokeDevice` is therefore async, and resolving means
both that the removal is on disk and that no other write to that file can
still land. It is enforced by ordering, with no repair-after-the-fact:

- the in-memory list stops trusting the device synchronously, before the
  first await, so live sessions are killed in the same tick;
- a generation counter, bumped by every authoritative write, which a flush
  re-checks in the SAME synchronous tick that dispatches its rename (no await
  between the check and the dispatch), so a revoke's synchronous generation
  bump can never slip in unseen: the flush either sees the bump and abandons
  its staging file, or it commits the rename and records it as in-flight;
- any pending flush timer is cancelled, so no new flush can start;
- the payload is read at flush EXECUTION time, never captured when the flush
  was scheduled;
- randomized, exclusive-create staging file names, so the two writers can
  never collide on a tmp path, and a pre-planted symlink at a predictable tmp
  path cannot be followed;
- and the one flush the generation bump cannot head off, the one whose rename
  is already on the threadpool, is the one the revoke waits for: it awaits
  exactly that in-flight rename (with no bound) before its own synchronous
  write, so the clean write is unconditionally last.

There is no bounded-wait-then-write-concurrently fallback and no
repair-after-the-fact. The earlier design did both: it waited a bounded 2s
for an in-flight flush, then wrote clean and corrected the file afterwards if
a stale rename had clobbered it. A rename stalled past that bound could land
after the revoke returned, leaving the revoked device transiently on disk
before the repair, so a crash in that window (or a failing repair write)
could persist it. Waiting for the actual in-flight rename removes that window
entirely: nothing stale is ever left behind for a later write to correct.

Durability is real, not just ordering: every authoritative write stages its
content to a temp file, fsyncs that file, renames it into place, and fsyncs
the parent directory, so a pairing or a revoke survives a power loss and not
merely a clean process exit.

Pairing was never exposed to the ordering hazard, because `addDevice`
mutates the cached array in place, so a stale flush would write identical
content. It stays synchronous, and it shares the same fsync-and-rename
durability path.

## Phases

1. Studio security and transport foundation (this repo): identity, QR pairing
   over LAN, explicit approval, silent listener with paired-key firewall, DHT
   presence, revocation, and the Settings surface. The same-machine LAN path is
   proven by `scripts/remote-access-e2e.mjs`, which drives
   `scripts/remote-test-client.mjs` through pairing, connection, and a terminal
   round trip with DHT disabled. `tests/e2e/remote-access-settings.spec.ts`
   drives the built Electron app through the real IPC gate for enable, QR,
   deny, approve, and revoke. These tests prove those code paths, not another
   network or a current physical-phone round trip.
2. Studio-shaped iOS companion, on the current `agent/bare-transport` mobile
   branch with the matching Studio feature branch: explicit workspace
   selection, home-scoped add-workspace browser, Explorer listing/preview plus
   create-folder/create-file/rename/move/Trash actions, read-only Source
   Control status and commit history/detail, Cora history/get/send, and shared
   Shell/Claude/Codex terminal profiles. Selection is workspace-wide rather
   than implicitly using the first returned workspace. The mobile owns the PTY
   grid for phone-origin panes through `terminal.resize`, as described above.
   The networking stack still
   runs inside a Bare worklet via `react-native-bare-kit` with the same
   `@hyperswarm/secret-stream` implementation as the desktop, so there is no
   second crypto implementation. The earlier pairing flow has been exercised
   on iOS, and automated interop covers the real worklet transport and the
   original protocol cases. It does not prove the expanded screens and RPCs:
   those are feature-branch code awaiting a fresh end-to-end physical-phone
   test. They are not claimed as merged or released.
3. Relay: small blind frame-forwarder, self-hostable, default instance on
   Codara Cloud. Studio and mobile gain the fourth rung of the ladder.
4. Later: file-content editing, Source Control mutations, richer live Cora
   event streaming, richer previews, and push notifications for run approvals.
   These are distinct from the bounded Explorer mutations, read-only Git
   snapshots/history, and bounded Cora messaging already in v0.
