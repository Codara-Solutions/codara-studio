# Remote Access

Remote Access lets a paired Codara Mobile app use the workspaces, terminals,
source control, and Cora data exposed by Codara Studio. It works on the local
network and, through Codara's blind relay, over cellular or another network.

Pairing is intentionally local. Normal sessions do not require the phone and
computer to share a network.

## Connection ladder

The phone tries:

1. The computer's recorded LAN addresses and stable Remote Access ports.
2. `wss://codara-remote-relay.codarasolutions.com/v1/relay`.

LAN is the fast path. The relay is the reliable fallback when NAT, carrier
networks, or firewalls prevent a direct socket.

Both paths carry the same end-to-end Noise IK stream. Changing paths does not
change the application protocol or its trust boundary.

## Identity and pairing

Studio creates one long-lived Ed25519 identity in:

```text
<spark-home>/remote/identity.json
```

The containing directory is mode `0700`; the file is mode `0600`. Writes use
exclusive, no-follow staging files, fsync, and atomic rename.

The phone creates its own Ed25519 identity and keeps its seed in the platform
secure store. Private keys never cross renderer IPC, appear in logs, or enter
the relay.

Opening the pairing dialog creates a single-use 32-byte secret with a two
minute expiry. Its QR payload contains:

```json
{
  "v": 1,
  "pk": "<Studio Ed25519 public key>",
  "addrs": ["<LAN address>"],
  "port": 45376,
  "secret": "<single-use secret>",
  "iat": 1770000000000,
  "name": "Studio name"
}
```

The phone must reach that listener over a private/local address and complete
Noise IK pinned to `pk`. It then proves the pairing secret. Studio shows the
phone name and the same short key fingerprint on both devices; only explicit
desktop approval writes the phone key to `paired-devices.json`.

The relay is never used for pairing. A public service cannot turn an unknown
phone into a paired device.

## LAN transport

Studio binds a small deterministic sequence of TCP ports derived from its
identity. This keeps a paired phone reconnecting across Studio restarts while
still recovering from a local port collision.

Every accepted TCP socket is wrapped in Noise IK. The responder does not speak
first. Unknown keys are silent unless:

- a pairing window is open;
- the remote address is local/private; and
- the connection remains inside the small pairing-candidate budget.

Pre-authentication sockets, completed-but-unapproved handshakes, live sessions,
frame sizes, and shutdown waits all have independent caps and deadlines.

## Relay transport

Studio keeps one outbound WSS control connection to the relay. The phone opens
its own outbound WSS connection only after LAN attempts fail. No inbound
router rule, public IP, VPN, user account, API key, or cloud credential is
required.

Relay authentication is signed by the same endpoint identities:

```text
codara-relay-auth-v1
<studio|phone>
<self public key>
<target Studio public key, phone only>
<timestamp>
<24-byte nonce>
```

The relay verifies canonical keys, signatures, clock freshness, nonce replay,
and rate limits. A phone authentication is bound to the exact Studio key
pinned during pairing.

The relay sends the claimed, signature-verified phone key to Studio. Studio
accepts a virtual stream only when that key is still in its local paired
device store. The two endpoints then run Noise IK over that virtual stream.
Studio verifies the Noise remote key equals the admitted key and re-checks the
paired-device store before it creates an RPC session.

This gives three authorization checks:

1. the relay verifies possession of the claimed phone identity;
2. Studio requires that identity in its local paired-device store;
3. end-to-end Noise proves the same identity again.

Revocation remains local and authoritative. Revoking a device kills its live
sessions immediately and the next relay request is rejected.

## What the relay can and cannot see

The relay can observe:

- source IP addresses and connection timing;
- the Studio and phone public keys needed for routing;
- encrypted frame sizes and directions;
- session duration and byte totals.

It cannot read:

- terminal input or output;
- filenames or file contents;
- source-control data;
- workspace names;
- Cora history or messages;
- RPC methods or results.

All of those exist only inside the Noise stream. A malicious relay can drop,
delay, replay, or record ciphertext and can deny service. It cannot decrypt a
session, modify it undetected, impersonate a paired phone, or impersonate the
pinned computer.

## Relay service

The relay lives in the separate private `codara-remote-relay` repository. Its
runtime surface is:

- `GET /health`;
- WebSocket upgrade at `/v1/relay`.

It has no database, persistent volume, application secret, Codara Cloud API
token, or payload log. WebSocket compression is disabled. It enforces:

- authentication and unmatched-connection deadlines;
- timestamp and nonce replay protection;
- per-IP and per-key authentication rates;
- per-IP and global connection caps;
- per-Studio pending and active-session caps;
- encrypted frame and output-buffer caps;
- per-session, per-phone, per-IP, and global byte budgets;
- maximum session lifetime and heartbeat cleanup.

The production container runs unprivileged. Codara Cloud supplies managed TLS
and keeps one replica always awake.

The initial deployment deliberately uses one replica because route ownership,
replay state, and daily quotas are in memory. Before horizontal replication,
those controls must move to a shared authenticated Redis deployment or the
relay must use deterministic shards. Adding replicas without shared routing
can place the phone and Studio on different processes.

Public identity creation remains permissionless so users need no account or
key. An attacker can create two identities and use their own bounded tunnel.
The byte and connection ceilings limit that abuse. If it becomes material,
the next admission layer is short-lived Apple App Attest / Google Play
Integrity tickets; those tickets supplement rather than replace Noise.

## Application protocol

After Noise opens, the phone and Studio exchange length-prefixed JSON frames.
The current RPC protocol version is `0`. A hello must complete before any
other request.

The exposed surface is intentionally bounded:

- workspace listing and adding a local workspace;
- workspace-bound directory and file operations;
- Git status, commit history, and commit detail;
- Cora run history and messages;
- workspace-scoped Claude and Codex session history;
- terminal create, resume, write, resize, and close.

Every file path is resolved inside the selected local workspace. File payload,
collection, terminal, session, and request sizes have explicit ceilings.
Renderer IPC never receives identity secrets or raw transport objects.

## Lifecycle and reconnection

Remote Access is restored at Studio boot when its setting was enabled. The LAN
listener and relay client both start from the persisted identity. The relay
client reconnects with bounded exponential backoff.

On the phone:

- background suspension releases the Bare worklet socket;
- foreground resume redials automatically;
- Wi-Fi/cellular transitions replace a stale connection even when the old
  socket has not yet reported failure;
- disconnected sessions retry with bounded exponential backoff.

Stopping and restarting `npm run dev` therefore does not require pairing or a
manual reconnect. The phone may briefly show the computer unavailable while
the old Studio relay socket closes and the new process authenticates.

## Tests

The principal coverage is:

- `npm run test:remote-access` — identity, pairing, stable ports, RPC contracts,
  and lifecycle;
- `npm run test:remote-access-e2e` — real LAN Noise, pairing approval, RPC, and
  PTY echo;
- `npm run test:remote-access-hostile` — handshake allocation, deadlines,
  shutdown, session caps, revocation durability, replay, and storage attacks;
- `codara-mobile npm run interop -- --studio <path>` — the real Bare phone
  transport against the real Studio service and the real sibling relay,
  including a PTY echo through the relay and hostile-server scenarios;
- `codara-remote-relay npm test` — signature, target binding, replay rejection,
  Studio admission, and blind binary forwarding.

Before shipping:

1. build all worklet bundles and pass bundle freshness/addon checks;
2. run the full Studio and mobile suites;
3. build a Release iOS app;
4. pair on Wi-Fi;
5. disable Wi-Fi and prove terminal traffic over cellular;
6. restart Studio and prove the phone reconnects without pairing again.
