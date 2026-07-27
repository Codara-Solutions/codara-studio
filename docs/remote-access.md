# Remote Access design

Mobile companion apps (iOS and Android) connect to a user's running Codara
Studio, with no Codara-hosted infrastructure on the happy path. This document
is the source of truth for the security model and the phases.

Reachability honesty (as shipped in phase 1): "from anywhere" is the design
goal, not a guarantee the current code can always keep. The shipped rungs are
the LAN direct connection and the DHT hole punch. When both sides sit behind
symmetric or carrier-grade NAT with UDP blocked, the hole punch cannot form a
path, and there is no relay yet (rung 4 is phase 3), so the phone simply
cannot reach the computer. In that case remote access is unavailable until
either side is on a friendlier network or the relay ships. Do not read the
"from anywhere" language below as a promise for those networks.

## Goals

- A phone can reach the user's computer from another network (5G, hotel
  wifi), as long as the computer runs Codara Studio, has internet access, and
  a NAT path can actually be formed (see the reachability note above: with
  symmetric/CGNAT and UDP blocked and no relay yet, it cannot).
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

Each rung is tried in order; the first that works wins.

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
- The phone resolves the computer by public key, then climbs the ladder.

## RPC surface (v0)

A versioned, length-prefixed JSON-RPC over the encrypted stream. Deliberately
narrow at first:

- `hello` (protocol version negotiation, device info)
- `workspaces.list`
- `terminal.create`, `terminal.write`, `terminal.resize`, `terminal.close`,
  server-pushed `terminal.data` events
- `ping`

The remote module is a second client of the same main-process services the
renderer uses, behind the same guards. It must not grow ad hoc file access;
any future fs RPC goes through the existing sandbox checks.

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

The studio foundation shipped on `agent/remote-access`. What follows records
the decisions a reader of the sections above would otherwise have to infer
from the code.

### Transport: Hyperswarm, both rungs

We took the primary candidate. `sodium-native` and `udx-native` ship N-API
prebuilds that load unmodified under this repo's Electron, so no native
rebuild step was needed (they are listed in `asarUnpack` because native
binaries cannot load from inside the asar archive). Two rungs share one
identity keypair:

- **Direct TCP** (LAN, and WAN wherever the router already forwards): a
  plain `net.Server` whose every connection is wrapped in
  `@hyperswarm/secret-stream` with the **IK** handshake pattern. The
  default pattern in that library is XX, which authenticates nobody in
  advance; IK is what makes the initiator prove it already knows our static
  key. This is the port the QR payload advertises. Known limitation, not yet
  fixed: production does not persist this port, so the OS picks a fresh
  random one on every process start, while the phone persists the port it saw
  in the QR at pairing time. After a desktop restart the phone's stored port
  is therefore stale, and the LAN rung fails; reconnection then depends on the
  DHT rung, and if that is also unavailable (UDP blocked, offline) the phone
  cannot reconnect until it re-pairs from a fresh QR. The intended fix is to
  persist a preferred port across restarts and fall back to a random one only
  if it is taken; until then this is a documented gap.
- **DHT**: a `hyperdht` server announced under the same keypair, with the
  `firewall` hook returning "block" for any key not in the paired list, so
  an unknown key cannot complete a connection at all.

Both rungs converge on the same post-handshake router, and the silent
listener rule holds structurally: the Noise responder never speaks first, so
a port scanner reads zero bytes, and an unknown key after handshake is
either a pairing candidate (only while a pairing window is open) or gets its
stream destroyed with nothing written.

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
  which is the property the modal's "same wifi" copy promises.
- **Explicit approval, not first-bearer-wins.** Proving the secret no longer
  silently trusts the device. It puts the request into a pending-approval
  state, and the desktop shows the requesting device's display name and its
  key fingerprint (the leading eight bytes of the key as uppercase hex in
  groups of four, byte-for-byte the short form the phone shows on its own
  confirm screen, so the user compares the two screens). The device is
  written to the trust store only after the user explicitly approves. A deny,
  or a timeout of about a minute, refuses with a clean stream close that the
  phone reads as a refusal rather than a hang. Consuming the secret at
  presentation time means a racing device cannot also redeem it; if the
  racing device is the one that reaches the approval prompt, the user sees a
  name and fingerprint that do not match their phone and denies. The wire
  format is unchanged: the phone sends the same pair request and simply waits
  longer for the reply.

### RPC v0 deviations from the mobile types

None in the payload shapes: `hello`, `ping`, `workspaces.list`,
`terminal.create/write/resize/close`, and the pushed `terminal.data` event
all match `codara-mobile/src/lib/remote/types.ts` field for field. Framing
details the mobile types deliberately leave open, and that the studio now
fixes:

- 4-byte big-endian unsigned length prefix, then that many bytes of UTF-8
  JSON.
- Inbound frames over 1 MiB are a protocol violation: the connection is
  destroyed without a response, and the limit really is checked against the
  declared length before the body is buffered. The decoder holds incoming
  bytes as a list of chunk views (it does not copy the whole chunk on
  arrival), so an oversized declared length is rejected from the 4-byte
  prefix alone, before any body bytes are copied, and fragmented
  byte-at-a-time delivery stays linear rather than quadratic.
- A single decrypted chunk is also capped at a maximum number of complete
  frames (a 16 MiB write of 6-byte frames would otherwise be millions of
  synchronous JSON.parse calls); exceeding that cap is fatal, like an
  oversized frame.
- `hello` must be the first call. Anything else before it answers
  `not-connected`.
- Per connection: at most 8 terminals (in-flight creates count toward the
  cap), and `terminalId` values are scoped to the connection, so they are
  not portable across reconnects.
- `terminal.create` resolves a `cwd` argument against the workspace root and
  refuses anything outside it. Both sides are passed through `realpath`
  first, so a symlink inside the workspace cannot be used to land the shell
  outside it, and the containment test compares path SEGMENTS so a directory
  legitimately named something like `..config` is not mistaken for an
  escape. The remote surface deliberately does not grow ad hoc filesystem
  access. Note the scope of this check: it constrains where the shell
  STARTS, not where the user can go afterwards. A remote terminal is an
  interactive shell and can `cd` anywhere the user can, by design, because a
  paired device is a fully trusted client.

### Trust model notes

Two consequences of where this feature sits, recorded so they are choices
rather than surprises:

- A compromised renderer can enable remote access and read a pairing QR
  payload (and therefore its one-time secret) over IPC. This is consistent
  with the existing IPC trust model, in which the renderer can already spawn
  terminals and read workspace files; the renderer is not a security
  boundary against itself. Key material is still never exposed: the identity
  secret key stays in the main process and is not reachable over any
  channel.
- Status and pairing-state pushes fan out to every live `webContents`,
  including preview tabs. Those payloads carry only connection state,
  device display names, and short key prefixes, never key material or
  pairing secrets, so the fanout leaks nothing a preview page could use.

### Revocation

Revoking removes the key from `paired-devices.json` and destroys every live
`RpcSession` for that key in the same tick, which closes that session's
terminals. A revoked device's next connection attempt is met with the same
silence as any unknown key.

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

1. Studio foundation (this repo): identity, QR pairing over LAN, silent
   listener with paired-key firewall, DHT presence, Settings panel (Remote
   access toggle, status, QR pairing modal, paired devices with revoke),
   plus `scripts/remote-test-client.mjs` proving pair + connect + terminal
   round trip from another network.
2. Mobile app v1 (new repo, likely React Native): pair, workspaces list,
   terminals, Cora chat.
3. Relay: small blind frame-forwarder, self-hostable, default instance on
   Codara Cloud. Studio and mobile gain the fourth rung of the ladder.
4. Later: file browsing and editing through the sandbox, previews, push
   notifications for run approvals.
