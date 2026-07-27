# Remote Access design

Mobile companion apps (iOS and Android) connect to a user's running Codara
Studio from anywhere, with no Codara-hosted infrastructure on the happy path.
This document is the source of truth for the security model and the phases.

## Goals

- A phone can reach the user's computer from any network (5G, hotel wifi),
  as long as the computer runs Codara Studio and has internet access.
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
  knowledge of the secret, and the two devices exchange and pin each other's
  public keys. The secret is single-use and never leaves the LAN.
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
  key. This is the port the QR payload advertises.
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
from above, so the listener bounds the blast radius instead:

- at most 8 unauthenticated sockets at once, refused silently beyond that;
- a 5 second handshake deadline, after which a socket that has not
  authenticated is destroyed (covering both the peer that goes silent and
  the one that dribbles bytes to look active);
- 64 total accepted sockets;
- TCP keepalive rather than a wall-clock idle timeout on ESTABLISHED
  sessions, so a paired phone may idle for hours with a terminal open;
- shutdown destroys tracked sockets itself and bounds its wait, because
  `net.Server.close()` on its own waits for every accepted connection to
  end, and a single silent peer would otherwise hold the listener, the DHT
  announce, the status update, and the whole enable/disable lifecycle open
  indefinitely.

The residual worst case is roughly 8 x 16 MiB held for up to 5 seconds. The
accepted cost is that eight simultaneous hostile sockets can delay a
legitimate pairing by a few seconds.

Concurrent sessions are capped per device (4, evicting that device's oldest
session rather than refusing the newcomer, so a phone reconnecting after a
dead socket is never locked out of its own computer) and globally (16,
refusing beyond that). Without those caps the 8-terminals-per-connection
limit bounded nothing, since a device could simply open more connections.

Outbound terminal output respects socket backpressure: when the peer stops
draining, the pty is paused at the OS level, and for a handle that cannot
pause, queued output past 1 MiB is dropped rather than buffered. Losing
scrollback to a phone that cannot keep up is recoverable; unbounded growth
in the main process is not.

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

### RPC v0 deviations from the mobile types

None in the payload shapes: `hello`, `ping`, `workspaces.list`,
`terminal.create/write/resize/close`, and the pushed `terminal.data` event
all match `codara-mobile/src/lib/remote/types.ts` field for field. Framing
details the mobile types deliberately leave open, and that the studio now
fixes:

- 4-byte big-endian unsigned length prefix, then that many bytes of UTF-8
  JSON.
- Inbound frames over 1 MiB are a protocol violation: the connection is
  destroyed without a response, and the limit is checked against the
  declared length before the body is buffered.
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
trust file has two writers: the synchronous authoritative one (pairing and
revoking) and an asynchronous cosmetic one (the coalesced last-seen flush).
Without care the second can undo the first, which would let a revoked device
be re-authorized on the next launch. The guarantee is that once
`revokeDevice` returns, no scheduled or in-flight flush can put that device
back, enforced by:

- a generation counter bumped by every authoritative write, which a flush
  carries and re-checks;
- cancelling any pending flush timer when an authoritative write happens;
- reading the payload at flush EXECUTION time rather than capturing it when
  the flush was scheduled;
- unique staging file names, so the two writers can never collide on a tmp
  path;
- and, for the one window the checks cannot pre-empt (a revoke landing while
  the flush's rename is already on the threadpool), re-asserting the
  authoritative state with a synchronous write once the rename returns.

Pairing was never exposed to this, because `addDevice` mutates the cached
array in place, so a stale flush would write identical content.

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
