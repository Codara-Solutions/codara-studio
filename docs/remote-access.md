# Remote access

Remote access lets a phone (the Codara companion app) watch and drive the
desktop: read runs, answer Cora's questions, edit boards, open terminals, and
receive notifications. Code lives in `src/main/remote-access/`; the shared
wire types are in `src/shared/remote-access.ts`.

## Pairing

1. The desktop keeps a static Noise identity in `~/.codarastudio/remote/`
   (private key mode 0600, directory 0700, written with O_EXCL staging).
2. Settings, Remote access shows a QR code carrying a 32-byte single-use
   pairing secret with a 2 minute TTL. Pairing requests are accepted only
   from loopback or private (RFC 1918) addresses, never through the relay,
   and you must approve the device in the app after checking its fingerprint.
3. Once paired, the device's public key is stored; revocation is immediate and
   durable.

## Transport

- Local: a TCP listener with a stable port (`stable-port.ts`) speaking Noise
  IK pinned to the desktop's static key (`listener.ts`).
- Relay: when the phone is not on the local network, both sides connect to
  the Codara relay over TLS (`relay-client.ts`). The relay only forwards
  ciphertext; a tunnel is accepted only if the claimed peer is paired and the
  Noise-derived key matches.

Inbound limits: 1 MiB frames, 32 in-flight requests, 4 MiB backlog, 8
terminals per device (`rpc.ts`, `terminal-leases.ts`).

## What a paired device can do

The RPC surface (`rpc.ts`, bound to live services in `production.ts`) covers
workspaces, files, git and GitHub, Cora runs (send, stop, resume, undo, fast
mode), boards and whiteboards, worker terminals, automations, notifications,
and terminals. Mutations carry idempotency keys recorded in a ledger
(`mutation-ledger.ts`) so retries over a flaky link do not double-apply.

There are no permission tiers yet: a paired device has the same authority as
the desktop UI. Treat pairing like handing over your laptop. Known gaps that
the review in `REVIEW.md` recommends closing: `workspaces.add` accepts your
home directory itself, remote terminals launch agents with permission
prompts skipped, and `cora.send` is not rate limited.

## Notifications on the phone

`phone-notify.ts` bridges the unified notification pipeline (`src/main/notify/`)
to paired devices with delivery receipts.
