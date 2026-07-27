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
  refuses anything outside it. The remote surface deliberately does not grow
  ad hoc filesystem access.

### Revocation

Revoking removes the key from `paired-devices.json` and destroys every live
`RpcSession` for that key in the same tick, which closes that session's
terminals. A revoked device's next connection attempt is met with the same
silence as any unknown key.

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
