# Remote access

Remote access lets the Codara phone app watch and drive this computer: follow
Cora runs and answer their questions, edit boards, browse files and git,
manage automations, open terminals, and get notifications, on your wifi or
from anywhere. It is off until you turn it on. This page starts with how to
use it and what a paired phone is allowed to do, then describes the security
design for anyone reviewing or changing it. The code is in
`src/main/remote-access/`, and the wire types shared with the phone are in
`src/shared/remote-access.ts`.

## Pairing a phone

1. Open Settings, **Remote access**, and switch it on.
2. Click **Pair a device**. A QR code appears; it is valid for two minutes and
   works once.
3. Scan it with the Codara app. Your phone must be on the same local network
   for this step.
4. Codara shows the phone's name and a short code. Check that the code
   matches the one on the phone, then click **Approve**.

The phone now appears under **Paired devices**. Revoking it there ends its
live sessions immediately and permanently. Turning remote access off stops
the listener and the relay connection.

## What a paired device can do

A paired phone can:

- list and add workspaces, and browse, read, create, rename, move and delete
  files in them;
- read git status and history, and work with GitHub pull requests and issues
  (review, publish, merge, auto-merge);
- follow Cora runs, send messages, stop, resume and undo, and edit a run's
  board;
- run, pause, resume and toggle automations, and use their worker terminals;
- open, attach to and type into terminals (up to eight per device);
- read and change Capability Center items, Cora memory and profiles;
- receive notifications.

There are no permission tiers yet: a paired device has the same authority as
the desktop UI. Treat pairing like handing someone your unlocked laptop.
Known gaps (see also the security section of
[the September 2026 review](./reviews/2026-09-codebase-review.md#4-security)):
a phone can add your home folder itself as a workspace, terminals it opens
start Claude Code and Codex with permission prompts skipped, and `cora.send`
is not rate limited.

## Identity and pairing

- The desktop has a static Noise identity in `~/.codarastudio/remote/` (the
  directory is mode 0700 and the private key 0600, written through exclusive,
  no-follow staging files).
- The QR code carries a 32-byte, single-use pairing secret that expires after
  2 minutes.
- Pairing requests are accepted only from loopback or private (RFC 1918)
  addresses, never through the relay, and only after you approve the device
  and its fingerprint in the app.
- Once paired, the device's public key is stored. Revocation is immediate and
  survives restarts.

## Transport security

- **Local network:** a TCP listener on a stable port (`stable-port.ts`)
  speaking Noise IK pinned to the desktop's static key (`listener.ts`).
  Unauthenticated connections get a short handshake deadline.
- **Relay:** when the phone is away from the local network, both sides
  connect to the Codara relay over TLS (`relay-client.ts`). The relay only
  forwards ciphertext: a tunnel is accepted only when the claimed peer is
  paired and the Noise-derived key matches, and payloads stay end-to-end
  encrypted. Once authenticated, Studio expects a relay heartbeat at least
  every 60 seconds.
- **Reconnecting:** the phone app gives the local network a 350 ms head start,
  then races the relay; the first pinned Noise handshake to succeed wins and
  the other attempts are cancelled. First-time pairing stays local-only.
- **Relay ownership:** before replacing a silent Studio connection, the relay
  probes it for two seconds, and a responsive Studio keeps its connection.
  Late frames from recently closed phone streams are ignored, so a cancelled
  phone cannot disconnect other sessions.

## Application protocol

`rpc.ts` defines the versioned, length-prefixed JSON protocol spoken inside the
encrypted stream, and `production.ts` binds it to the app's live services.

- Inbound limits: 1 MiB per frame, 32 requests in flight, a 4 MiB write
  backlog, and 8 terminals per device (`rpc.ts`, `terminal-leases.ts`).
- Mutations carry idempotency keys recorded in a ledger
  (`mutation-ledger.ts`), so a retry over a flaky link never applies twice.
- Notifications reach the phone through `phone-notify.ts`, which bridges the
  app's notification pipeline (`src/main/notify/`) to paired devices with
  delivery receipts.

## Running the relay

The relay's code is not in this repository. It must run as a single replica
until connection routing has shared ownership. Its aggregate `relay_metrics`
logs report active connections and sessions, forwarded bytes, slow receivers,
buffer high-water marks and accept latency; it never inspects application
messages.

For the full list of files Codara keeps for remote access, see
[on-your-machine.md](./on-your-machine.md).
