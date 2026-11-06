# Bot connector

Design for a read-only connector that lets a hosted bot read a few facts
about this computer's agent sessions. Nothing in this page is implemented.
The phone remote-access path is the starting point
([remote-access.md](./remote-access.md), `src/main/remote-access/`).

The connector is off until the operator turns it on. A paired bot is not a
phone: it cannot type, write, or see a workspace the operator did not
check. Credential redaction runs in Studio, on the text, before a response
is framed for the wire.

## 1. Architecture

### What already exists

Remote access pairs a phone with this computer and then lets it connect
from anywhere.

- Studio keeps a static Noise identity in `~/.codarastudio/remote/`
  (`identity.ts`). Paired devices live in `paired-devices.json`
  (`pairing.ts`). Revoking a key drops its live sessions before the
  revoke returns.
- First pairing is a two-minute, single-use secret on the local network.
  `listener.ts` accepts a pairing candidate only from a loopback or
  private address, and only while a pairing window is open. The relay
  never accepts a stranger: `RemoteRelayClient` opens a tunnel only when
  `isAuthorized` already knows the peer's key.
- After pairing, the phone and Studio speak Noise IK end to end. The
  relay forwards ciphertext. It is not a trust anchor
  (`relay-client.ts`).
- Inside the encrypted stream, `rpc.ts` speaks versioned,
  length-prefixed JSON (`RPC_PROTOCOL_VERSION` is 1, frames at most
  `MAX_FRAME_BYTES`, 1 MiB). A paired phone may do what the desktop may
  do. There is no read-only role today.

That last point is why a bot cannot be "just another phone". Pairing a
phone hands over terminals, files, git writes, and `cora.send`.

### Choice

A small hosted bridge holds one bot Noise key, connects out to the same
relay, and completes Noise IK with Studio the way a phone does. The
bridge is the MCP server the bot talks to, over HTTPS, with OAuth. Studio
is the resource. The bridge is a paired device whose role is `bot`.

```
bot  -- HTTPS, OAuth -->  bridge  -- Noise IK, via the relay -->  Studio
                            |                                      |
                     bot device key                         redacts, then
                     fixed MCP tools                        role allowlist
```

The relay stays in the middle and still sees only ciphertext. Studio
makes the outbound relay connection, as it does for phones. The bridge
also connects out. Neither side opens an inbound port on the operator's
network for this feature.

v1 is one Studio, one bridge, one bot key. The bridge is not
multi-tenant. Its code does not live in this repository, for the same
reason the relay's code does not: the bridge holds a long-lived device
private key and an OAuth client secret, and this repository is public.
This page is the contract. A private repository implements the bridge
against it.

### Why a tunnel was set aside

The alternative is Studio itself serving MCP, reached through a tunnel
(a TCP tunnel, a TLS-terminating edge tunnel, or a mesh funnel).

| | Paired bot over the relay | Studio serving MCP through a tunnel |
|---|---|---|
| Who can open a session | A key the operator stored, checked again by Noise | Whoever can present whatever credential the tunnel and the HTTP server accept |
| What the path operator sees | Ciphertext. The relay never sees application bytes | A TLS-terminating tunnel sees the MCP plaintext |
| Where Studio listens | Outbound relay only. Bot-only mode does not open the LAN port | An HTTP server, or a local port the tunnel agent dials |
| Which tools exist | Five read RPCs, gated in `rpc.ts` | The shipped MCP server (`resources/codara-studio-mcp`) is the full studio set: terminals, files, browser. Publishing it publishes those tools |
| Revoke | The existing paired-device revoke | A new credential store |
| Redaction | In Studio, before the Noise frame | Still has to be in Studio. The tunnel does not remove that work |

The tunnel does not remove the hard part. Studio would still need a
read-only allowlist and the same redactor, and it would grow an inbound
HTTP and OAuth surface it does not have. The existing MCP server is the
wrong process to publish: every call is a loopback JSON-RPC into the
app with the session token in `agent-socket.json`, and the tool set is
the one agents use to drive the computer.

The relay path is the one that already has outbound connectivity,
pinned Noise, a paired-key check, immediate revoke, frame limits, and a
device rate limiter (`device-rate-limit.ts`). The new work is a role, a
redactor, and five read methods.

### Pairing a bridge that is not on the LAN

Phone pairing cannot be reused as a wire ceremony. The bridge is not on
the operator's network, and pairing frames are refused on the relay on
purpose, so a relay cannot inject a device.

v1 pairing is a fingerprint check the operator does by hand:

1. The operator turns the connector on. With no bot key stored, Studio
   does not open a relay tunnel for it. It does create the empty
   secrets file from [Redaction](#3-redaction).
2. The bridge generates its own Noise static keypair and shows the
   public key and its fingerprint. The private key stays on the bridge.
3. The operator pastes the public key into Settings. Studio shows the
   fingerprint from `keyFingerprint` and the short id from `shortKey`.
   The operator confirms it matches the bridge.
4. Studio writes one `PairedDeviceRecord` with `role: "bot"`. There is
   no pairing window and no QR.
5. Settings also shows Studio's own public key, which the bridge pins
   for Noise IK. That key is already on the phone QR. It is not a
   secret. Studio's private key never leaves `~/.codarastudio/remote/`.

The relay then accepts the bridge only because `isAuthorized` returns
true, and Noise checks the same key again. This keeps the rule in
`listener.ts`: the relay rung never accepts strangers.

Role rules, so a paste cannot change what an existing key may do:

- A record with no `role` is a phone. Existing `paired-devices.json`
  files keep today's authority. The file version stays 1.
- The QR pairing path (`addDevice`) writes `phone` and refuses a key
  that is already `bot`.
- The bot paste path refuses a key that is already `phone`.
- Nothing rewrites a role in place. Replacing a bot means revoke, then
  paste a new key.

### Bot-only relay

The phone switch and the bot switch are independent.

- Bot on, phone remote access off: start `RemoteRelayClient` only. Do
  not bind the LAN port and do not open a pairing window.
- Both on: one relay connection, the one the listener already owns.
- Bot off: `isAuthorized` is false for the bot key and its tunnels are
  dropped. A phone relay that is still on stays up.
- Phone remote access off: unchanged from today, except that a bot-only
  relay is allowed to exist beside it.

### What crosses the bridge

The bridge exposes five MCP tools, each mapped to one RPC below. It
drops any other tool name before it touches the relay. It has no
generic "call this RPC" tool. Studio repeats the check: a bot key that
asks for `files.read`, `cora.send`, `github.merge`, or a terminal
profile is rejected in `RpcSession` before the handler runs, and the
response body is an error, not a partial result.

OAuth is the bot's credential for the bridge, not a credential Studio
understands. Grok Bot custom connectors authenticate with OAuth only.
Cursor staff, on the forum in September and October 2026, said there
is no safe static bearer or custom-header path in the Grok Bot UI.
Dynamic client registration is the default connect path.

HTTPS only. Authorization code with PKCE (S256). There is no open or
anonymous registration. Registration is allowed only when every
redirect URI is one of the three a Grok Bot client registers, or one
of the redirect URIs on the published client metadata document. Any
other redirect URI is refused.

The client registers these redirect URIs:

1. `cursor://anysphere.cursor-mcp/oauth/callback`
2. `https://www.cursor.com/agents/mcp/oauth/callback`
3. `http://localhost:8787/callback`

The published client metadata document is
`https://cursor.com/oauth/mcp-client.json`. Its `client_id` is that
URL. Its `redirect_uris` include the agents and bot HTTPS callbacks,
`https://grok.com/connectors-oauth-exchange-code/`, and localhost and
`127.0.0.1` loopbacks. A flow may present that client id instead of
registering a new one. That document is an allowed registration
source on the same rule.

A newly registered client gets no access until the operator approves
it on the bridge. A pre-registered static client id and secret remains
for a client other than Grok Bot that cannot do dynamic registration.

- Access tokens last 15 minutes. Refresh tokens rotate. Presenting a
  refresh token that was already rotated revokes that token family.
- The token's audience is this MCP resource. Tokens do not appear in
  query strings. The bridge does not log tool arguments or results.
- The bridge never puts the device private key, Studio's key, or an
  OAuth token into a tool result.

## 2. Read tools for v1

Five reads. No writes. Names on the wire are the RPC methods. The MCP
tools use the same words with underscores (`bot_sessions_list`, and so
on). `hello` and `ping` stay available so the existing session handshake
still works. No other existing method is available to a bot key.

Every list is filtered to the workspaces the operator checked. The
filter runs in Studio. A bot that names anything outside that set gets
`not-allowed` and no body. The error does not echo the arguments and
does not say whether the workspace or session exists.

Strings in every response pass through the redactor in
[Redaction](#3-redaction) before `encodeFrame`.

### `bot.sessions.list`

Which sessions are working, waiting on the operator, or done.

Source: `buildAgentBoard` in `src/shared/agent-board.ts`, then the
inbox settle and snooze prefs in `src/shared/agent-inbox.ts`. The three
buckets match the Agents tab:

| Bot bucket | Board bucket | What the operator sees |
|---|---|---|
| `working` | `working` | Working, including background, stalled, starting |
| `needs-you` | `needs-you` | Waiting on the operator |
| `done` | `done` | Finished, inside the same done window the board uses |

Snoozed and settled cards are left out, as they are on the open Agents
sections. A background card with no session of its own is listed, and
the transcript call for it returns `not-allowed` rather than a guessed
file.

The call takes `since`. When the caller omits it, `since` is the start
of today in the computer's local time. The board rows are still
returned. The board's done window drops a session the operator worked
in earlier today, and that is the session a daily summary needs, so
Studio also returns sessions from the session index whose activity is
after `since`. Activity is the index row's `lastAt`. The same
workspace filter applies: a session the index cannot place in a
checked workspace is left out. A session already returned from the
board is not repeated. An added row is marked `source: index` and
carries the same row fields. The index fills `sessionKey`, `runtime`,
workspace id and name, title, branch when it has one, and `since`
(that `lastAt`). `boardKey`, bucket, the status word, and `unseen`
stay unset, because there is no board card to copy them from.

Each row: `boardKey` (`pane:<id>`, `run:<id>`, or `worktree:<workspaceId>`)
when the row is a board card, `sessionKey` when the session index or
`agent-session-registry.ts` has one, `bucket` and the board status
word when the row is a board card, `runtime`, workspace id and name,
title, branch when one is already known, `unseen` when the row is a
board card, `since`, and `source` (`index` on a row that came from the
session index). No message body. No account label (those can be an
email). No absolute path.

### `bot.sessions.transcript`

The full transcript of one session, in pages.

"Full" means the CLI transcript file, not the session-search index.
The index keeps user and assistant prose and drops tool calls
([agent-session-search.md](./agent-session-search.md)). Tool arguments
and tool output are where keys are pasted, so a transcript tool that
returned only the index would miss the text this design exists to
scrub, and would also hide the work the bot is supposed to read.

Resolution:

- A `sessionKey` uses the same root check as `verifiedTranscriptPath`
  in `src/main/session-search/service.ts`: the real path must sit under
  a folder the index is allowed to read for that agent.
- A `pane:` board key uses the transcript path on the session registry,
  then the same root check.
- A `run:` board key reads that run's `events.jsonl` under
  `~/.codarastudio/runs/`. Those files are already scrubbed when Cora
  wrote them (`scrubSecrets`). The bot redactor runs again anyway.
- A `worktree:` key has no transcript. The call returns `not-allowed`.

Paging is by record, not by cutting a byte range through a line. One
JSONL record is redacted whole. Records are packed into a page until
the next redacted record would pass 256 KiB. A raw record over 1 MiB
is omitted and counted (`omitted`), which is the same line cap the
index already uses, and it is not sent. The call takes `from`:
`"start"` or `"end"`, default `"end"`. `"end"` reads the most recent
records first and pages backwards. `"start"` reads from the first
record and pages forwards. The caller passes `cursor` from the
previous page, which continues in that direction. `hello` framing
still applies: a page stays under `MAX_FRAME_BYTES`.

Long sessions run to tens of MB. The byte budget stays 32 MiB of
response bytes per rolling hour ([Controls](#4-controls)). The default
reads the recent end first, so that budget is not spent on the oldest
records.

The response is redacted text plus role and time when the record has
them. It is not the raw line. Paths in the record are redacted as text.
The response does not add a filesystem path of its own.

### `bot.sessions.summary`

A short extract of one session. Studio does not call a model to write
it. A model summary would send the transcript to another provider,
which is a second egress this design does not allow.

Contents: redacted title, bucket, status word, runtime, workspace name,
branch if known, and the last user line and last assistant line. Those
two lines come from the session index (prose only) and are clipped to
500 characters, the same cap as `AGENT_SESSION_LIST_MESSAGE_CHARS`.
When the index has no row, the board card's `message` is used instead
and marked `live`, so a summary still works with session search off.
A row marked `source: index` has no board bucket or status word. Its
summary uses the index fields and the same two lines. The index
excerpt is not a substitute for the transcript tool.

### `bot.pulls.list`

Open pull requests for repositories Studio already tracks from an
allowed workspace. Source: the pull-request half of
`src/main/github-work-queue.ts` (`listOpenPullRequests`), filtered by
`sourceWorkspaceId`.

Each row: repository (`owner/name`), number, redacted title, url,
draft flag, head branch, author login. No body, no diff, no check log.
Those are the texts `redactSecrets` in `src/shared/git-fix.ts` exists
for, and v1 does not send them.

### `bot.worktrees.list`

Worktrees of allowed workspaces. Source: `listWorktrees` in
`src/main/worktree-cleanup/inspect.ts` (`git worktree list --porcelain`).

Each row: workspace id, branch, the worktree's directory name, whether
it is the main checkout, locked, prunable. Absolute paths stay in
Studio. A home path contains the account name on the computer, and the
bot does not need it to tell worktrees apart.

### Not in v1

Writes of every kind. Terminals. `cora.send`. File contents. CI logs.
PR bodies and diffs. Memory, capabilities, account status. A
model-written summary. More than one bot key. Sharing one bridge
across Studios.

## 3. Redaction

Redaction runs in the main process, on the value that is about to be
passed to `encodeFrame`. The bridge is not a redaction layer. A bug
that logged the Noise plaintext on the bridge would still see only
text Studio has already scrubbed. If the redactor throws, or the
secrets file or an env file the operator pointed at cannot be trusted,
Studio sends no frame.

The phone path is unchanged. A phone is the operator's own device and
already has the desktop's authority. This redactor is bot-only. Putting
it on phone responses would be a different change.

### Which scanner

Reuse `scrubSecrets` in `src/shared/memory-items.ts`. It is the scanner
that already rewrites text before Cora stores it, and
`scripts/test-scrub-secrets.cjs` is the table of what it must catch and
what it must leave alone (prose, paths, identifiers, link fragments,
a second pass over its own output).

Do not use `redactText` in `src/main/diagnostics/redact.ts` as this
channel's scanner. That one also removes email addresses, home paths,
and any mixed 32-character token. Those rules are right for a
diagnostics bundle and wrong for a transcript: the bot would lose
paths, ids, and commit context. Commit hashes stay, as that file
already keeps them, because this design never applies the 32-character
rule.

`scrubSecrets` does miss shapes the other two scanners catch. The bot
redactor runs those extra shapes after `scrubSecrets`, and does not
change `scrubSecrets` itself (callers depend on its `[redacted]`
marker):

- Underscore provider keys from `SECRET_PATTERNS` in
  `src/shared/git-fix.ts`: `sk_live_`, `sk_test_`, and the `rk_` and
  `pk_` forms. `scrubSecrets` requires a hyphen after `sk`, `rk`, or
  `pk`, so `sk_live_...` would otherwise pass.
- `xai-` tokens and `npm_` tokens, which `redactText` and
  `redactSecrets` already flag.

The wire marker for this channel is `[key removed]`. `scrubSecrets`
writes `[redacted]`. The bot function rewrites that marker after the
shape pass so a caller sees one token. Card numbers that `scrubSecrets`
already removes use the same marker. One token keeps the second-pass
test honest.

### The operator's secrets file

Shape rules miss a password that does not look like a key. The operator
keeps those values in one local file:

`~/.codarastudio/bot-redact-secrets.txt`

Studio creates it empty, mode 0600, in a 0700 directory, when the
connector is turned on. The write uses the same no-follow staging
pattern as `identity.ts`. If the path is a symlink, Studio refuses bot
reads. On macOS and Linux a mode other than 0600 also refuses bot
reads. The file is never an RPC result, never copied into a workspace,
and never written into the audit log. Studio re-reads the file when
it changes, before the next bot read.

Format: UTF-8, one value per line, the raw value, not `KEY=value`.
Blank lines and lines whose first non-space character is `#` are
ignored. A value shorter than 8 characters is ignored, the same floor
as `KNOWN_MIN` in `pasted-secrets.ts`, so a short word cannot punch
holes in prose. A value longer than 256 characters is ignored. More
than 200 values, or a file over 64 KiB, refuses bot reads until the
operator shortens it. Settings says when lines were ignored.

Exact match is literal, case-sensitive, longest value first, and only
at token boundaries (the character before and after is missing or not
a letter or digit). A value inside a longer identifier stays.

The exact set also includes values from
`~/.codarastudio/pi-agent/pasted-keys/<run>.json` for which `keyLike`
is true. Those are keys the operator already pasted into a Cora run.
Label-only pasted values stay out of the exact set: `pasted-secrets.ts`
already refuses to rewrite branches and commands with a word that was
only secret because of its label (`token: codara-studio2`).
`scrubSecrets` still removes that word when the label sits next to it.
A missing pasted-keys directory means there are none. An unreadable
one refuses bot reads.

### Operator-chosen env files

Copying every key into the raw file a second time will not happen.
Settings lets the operator point at one or more existing `KEY=value`
files. The raw file stays for a value that lives nowhere else.

Syntax is dotenv. UTF-8, one assignment per line. The key is ignored.
Only the value is loaded, and only when it passes the same length
floor and ceiling as the raw file (8 to 256 characters). A value may
be unquoted or wrapped in single or double quotes. The quotes are not
part of the value. An optional leading `export` is ignored with the
key. Blank lines and lines whose first non-space character is `#` are
comments and are not loaded. Settings says when lines were ignored,
as it does for the raw file.

Each file follows the raw file's rules. Studio opens the path
no-follow. If it is a symlink, Studio refuses bot reads. On macOS and
Linux a mode other than 0600 refuses bot reads. More than 200 values,
or a file over 64 KiB, refuses bot reads. An unreadable file, or a
listed path that is missing, refuses bot reads. The file is never an
RPC result, never copied into a workspace, and never written into the
audit log. Studio re-reads it when it changes, before the next bot
read. Loaded values join the exact set: literal, case-sensitive,
longest first, token boundaries only.

Studio does not decrypt `spark-remote-secrets.json` for this, and it
does not walk a workspace looking for env files. It reads a file only
when the operator pointed at that path. Those files are not sent. A
secret that lives only in a file nobody pointed at, and that is not in
the raw file, is removed when it matches a shape and otherwise can
leave.

### Order

On each string:

1. Exact values, longest first, become `[key removed]`.
2. `scrubSecrets`.
3. The extra shapes above, on whatever remains.
4. Rewrite a remaining `[redacted]` to `[key removed]`.

A second call on the output returns it unchanged. Records are redacted
whole, so a value split across two records is the only residual gap,
and a skipped oversized record is not sent.

### Fail closed

No frame at all when any of these is true:

- The redactor throws.
- The secrets file is missing after it was created, unreadable, a
  symlink, the wrong mode, or over the size or count cap.
- An env file the operator pointed at is missing, unreadable, a
  symlink, the wrong mode, or over the size or count cap.
- The pasted-keys directory is unreadable.

An empty secrets file is valid. An empty env-file list is valid.
The audit line for a refusal records the method and the reason code.
It does not record the text.

### Test plan

`scripts/test-bot-redact.cjs` loads the pure function the way
`scripts/test-scrub-secrets.cjs` loads `scrubSecrets`. Every row is one
assertion. `flag` means the sample contains none of the secret and does
contain `[key removed]` where the secret stood. `pass` means the output
equals the input. Samples are fake. A second call on every `flag`
output is itself a `pass`.

The shape rows are the cases `test-scrub-secrets.cjs` already fixes,
plus the underscore key that file does not cover. The secrets-file rows
and the env-file rows are the gap that file cannot see, because
`hunter2hunter2` with no keyword is ordinary text to `scrubSecrets`.

| Case | Input sample (fake) | Must | Expected |
|---|---|---|---|
| Hyphen API key | `use this key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234 for the deploy` FAKE_ | flag | key replaced, surrounding words kept |
| Underscore API key | `sk_live_FAKEVALUE1234567890abcd` FAKE_ | flag | `[key removed]` |
| GitHub token | `token: ghp_AbCdEfGhIjKlMnOpQrStUvWx1234567890` FAKE_ | flag | value replaced, `token:` kept |
| Bearer hex | `Authorization: Bearer 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b` FAKE_ | flag | `Bearer [key removed]` |
| AWS example key | `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` FAKE_ | flag | name kept, value replaced |
| URL userinfo | `postgres://admin:s3cretpw@db:5432/x` FAKE_ | flag | `postgres://[key removed]@db:5432/x` |
| Private key block | a line `-----BEGIN RSA PRIVATE KEY-----` plus a body and an END line FAKE_ | flag | block replaced |
| Keyword assignment | `password=Tr0ub4dor&3` FAKE_ | flag | `password=[key removed]` |
| Keyword prose | `my password is hunter2hunter2 ok` FAKE_ | flag | `my password is [key removed] ok` |
| JWT shape | `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.FAKE_c2lnbmF0dXJlMTIzNDU2` FAKE_ | flag | `[key removed]` |
| xAI token shape | `xai-FAKEVALUE1234567890abcd` FAKE_ | flag | `[key removed]` |
| npm token shape | `npm_` plus 36 alphanumerics, the line marked FAKE_ | flag | `[key removed]` |
| Card number | `card 4111 1111 1111 1111 please` FAKE_ | flag | `card [key removed] please` |
| Secrets-file value, no keyword | file contains `hunter2hunter2`; text is `deploy with hunter2hunter2 today` FAKE_ | flag | value replaced |
| Secrets-file value at a boundary | file contains `hunter2hunter2`; text is `prefix-hunter2hunter2-suffix` FAKE_ | flag | value replaced, hyphens kept |
| Env-file value, unquoted | file line `API_TOKEN=hunter2hunter2`; text is `deploy with hunter2hunter2 today` FAKE_ | flag | value replaced, key ignored |
| Env-file value, quoted | file line `API_TOKEN="hunter2hunter2"`; text is `deploy with hunter2hunter2 today` FAKE_ | flag | value replaced, quotes not loaded |
| keyLike pasted key | pasted-keys holds `sk-proj-Zq8Xw2Lp9Rt4Vb7Nm3Kd6Hf1Gj5Sc0Ya`; text repeats it bare FAKE_ | flag | `[key removed]` |
| Normal prose | `session finished green` | pass | unchanged |
| Keyword without a secret | `the token is expired, can you refresh it` | pass | unchanged |
| Keyword without a secret | `the password is incorrect` | pass | unchanged |
| Library name | `use sk-learn-compatible-models here` | pass | unchanged |
| Ordinary work talk | `run npm test in src/main and open PR #42` | pass | unchanged |
| Home-looking path | `/Users/ada/code/app/worktrees/fix-login2` | pass | unchanged |
| Source path | `src/main/orchestration/run-store.ts` | pass | unchanged |
| Commit hash | 40 lowercase hex characters | pass | unchanged |
| Long decimal id | `ping the bot in channel 1296016829456515086` | pass | unchanged |
| Id labelled as an id | `run id is 4532015112830366` | pass | unchanged |
| Identifier | `rename useWorkspaceTaskSummaryForRail2Helper to something shorter` | pass | unchanged |
| Link fragment | `https://x.io/cb?state=` plus a 40-character token FAKE_ | pass | unchanged, matching the scrubber |
| File name made of a token | `open ` plus a 40-character token plus `.json` FAKE_ | pass | unchanged |
| Image data URI | `data:image/png;base64,` plus a short icon payload FAKE_ | pass | unchanged |
| Secrets-file comment | file line `# hunter2hunter2`; text contains `hunter2hunter2` FAKE_ | pass | unchanged |
| Env-file comment | file line `# API_TOKEN=hunter2hunter2`; text contains `hunter2hunter2` FAKE_ | pass | unchanged |
| Secrets-file value too short | file line `green`; text is `session finished green` | pass | unchanged, value not loaded |
| Value inside a longer word | file contains `hunter2hunter2`; text is `hunter2hunter2Helper` FAKE_ | pass | unchanged |
| Label-only pasted word | a run pasted `token: codara-studio2`; text is branch `codara-studio2` | pass | unchanged |
| Second pass | the output of any flag row, including a bare `[key removed]` | pass | unchanged |

Two wiring tests live with the RPC work, not in this table: a bot
response fixture that contains `sk-proj-FAKE_...` never appears on the
bytes handed to the stream, and a redactor failure produces zero
bytes.

## 4. Controls

All of these are in Studio. The bridge repeating them is welcome and
is not the control.

| Control | Behavior |
|---|---|
| Off by default | A new switch, next to Remote access, default off. The phone switch does not turn it on. Off makes `isAuthorized` false for the bot key and drops its tunnels. The key is kept, so on is one switch. |
| The operator turns it on | Settings. Turning it on creates the secrets file if needed, shows the paste-a-public-key form, and is where the operator points at env files. The relay starts only once a bot key is stored. |
| Revoke in one click | The paired-device revoke already in Settings. `revokeDevice` forgets the key and drops live sessions before it returns. The bridge must be pasted again. |
| Read-only role | `role: "bot"` on the device record. `RpcSession` allows `hello`, `ping`, and the five `bot.*` methods. Every other method is `not-allowed` before the handler. A phone key that calls `bot.*` is refused too, so this redactor stays on one path. |
| Workspaces | A checklist of workspaces on this computer, default none. Empty means list calls return empty lists, and a call that names a session returns `not-allowed`. Stored in Studio settings. The bridge cannot widen it. |
| Rate limit | A `DeviceRateLimiter` keyed by the bot public key, owned by the service so a reconnect does not refill it. Separate from the `cora.send` bucket (`CORA_SEND_BURST` 20, refill 3 seconds). Bot budget: burst 10, then one request every 2 seconds, at most 2 in flight, and 32 MiB of response bytes per rolling hour. Over the limit, an error and no body. |
| Audit log | `~/.codarastudio/logs/bot-audit.jsonl`, mode 0600, one JSON line per read and per refusal. Fields: time, device short key, method, workspace id, session key or pull number, redacted byte count, replacement count, reason code on a refusal. No titles, no bodies, no secret values. Rotated once at 5 MB, same idea as `logs/worktree-audit.jsonl`. Settings shows the last 50 lines. |

Workspace ids and session keys are the only identifiers the log needs.
Titles are themselves redacted text and do not belong in a second file.

## 5. Threat model

Redaction removes credentials. It does not make the work public. A
transcript can still contain unreleased code, private bugs, and names
the operator would not post. The off switch, the workspace checklist,
and revoke are what limit that. The table is the extra damage if a
credential is stolen, assuming the operator has the connector on and
has checked some workspaces.

| Attacker has | Can read | Cannot read or do | What stops them |
|---|---|---|---|
| The relay, or anyone on the network path | Ciphertext, connection timing, byte counts | Plaintext, the device key, Studio's key | Noise IK. The relay never gets application bytes. Pairing frames are not accepted there |
| A stolen OAuth access token | The five tools, redacted, for the checked workspaces, until the token expires (15 minutes) | Studio's relay, the device key, other Studios, write methods | Audience is the MCP resource. The bridge maps tools one-to-one. Studio's allowlist is the backstop. Revoke or switch off cuts it even if the token has not expired, because the bridge's device session dies |
| A stolen OAuth refresh token | The same reads, for as long as the refresh token works | The same | Rotation. Reuse of an old refresh token revokes the family. The operator can revoke the client on the bridge without a Studio release |
| A compromised bot product | The same reads as a stolen token. It sees redacted tool results the bridge returns | The device private key, unless the bridge put it in a tool result, which the contract forbids. No write RPCs | Same as a stolen token. Workspace checklist and rate limit still apply. Audit lines show the reads |
| A compromised bridge | Everything the allowlist allows, for the checked workspaces, already redacted. It holds the device key, so it does not need OAuth | Anything outside the five methods. The secrets file and the env files the operator pointed at. Studio's private key. Other devices' sessions. Unredacted text, except a value the redactor missed | Role gate in `RpcSession`. Redaction before the frame. Rate limit and byte cap. One-click revoke. One bridge, one Studio, so the key is not a key to anyone else's computer |
| A missed redaction pattern | That one value, inside a response the bot was allowed to fetch | Values that match a listed shape, the raw secrets file, or an env file the operator pointed at | Fail closed on redactor errors. The test table. The operator adds a value the shapes miss, in the raw file or by pointing at the file that already holds it |
| Prompt injection in a transcript | Attacker-controlled text a session already holds (a web page, a PR comment, a client message). The bot reads it with the rest of that transcript | A write. That text is not a tool call, and v1 has no write tools | v1 has no write tools, which is the mitigation. Any future write connector must treat transcript text as untrusted |

A value the shapes miss, and that is not in the raw file or an env
file the operator pointed at, can leave. That is the residual risk of
a pattern redactor. Those two sources are how the operator closes a
hole without a release. They are not a claim that every password on
disk is known.

The bot also reads attacker-controlled text that a session already
contains: a web page, a PR comment, a client message. v1 has no write
tools, which is what stops that text from becoming an action. Any
future write connector must treat transcript text as untrusted.

Turning the connector off or revoking the device stops the reads.
Both take effect without waiting for an OAuth token to expire.

## 6. v1 plan as small pull requests

Each implementation pull request stays under 800 changed lines, tests
included, and lands on its own. None of them is this page. Product
code waits until this design is accepted. The bridge repository is
separate and can start once the RPC names below are stable.

Tests are the registry suites (`npm test -- <name>`), plus
`npm run typecheck` on any pull request that touches `src/`.

1. **Redactor.** A pure module, no Electron and no RPC.
   `scripts/test-bot-redact.cjs` is the table in
   [Test plan](#test-plan), including the secrets-file loader (temp
   directory, mode, symlink refusal, size cap), the env-file list
   (quoted value, unquoted value, comment, and the same mode, symlink,
   and size caps), and pasted-keys fixtures. Marker is `[key removed]`.
   `scrubSecrets` stays as it is.
2. **Role gate.** Optional `role` on `PairedDeviceRecord`, absent means
   phone. Dispatch refuses every existing method for `bot` and refuses
   `bot.*` for `phone`. QR pairing cannot flip a role. Tests on the
   paired-device store and on `RpcSession` with a fake socket. No new
   read handlers yet.
3. **Switch, paste, revoke, relay.** The settings flag defaults off.
   Paste stores a bot key after the fingerprint is confirmed. Revoke
   uses `revokeDevice`. Bot-only mode starts `RemoteRelayClient`
   without the LAN listener. The workspace checklist is stored and
   default empty. Enabling creates the secrets file. The env-file
   paths are stored beside that checklist. Tests cover the
   service lifecycle the way the remote-access suites already drive
   `RemoteAccessService` without a window. The Settings section is a
   separate pull request if this one would cross 800 lines.
4. **List, summary, limit, audit.** `bot.sessions.list` (board rows,
   plus index rows after `since` marked `source: index`) and
   `bot.sessions.summary` from a fixture board, workspace filter,
   redaction on the bytes written to the test stream, the bot rate
   limiter (reconnect does not refill), and one audit line that
   contains no title and no secret. A redactor throw writes zero
   bytes.
5. **Transcript.** `from` defaulting to `"end"` and paging backwards,
   record paging, the root check, omitted oversized
   records, tool fields included, a fixture JSONL whose fake key is
   absent from the framed output. Cora `events.jsonl` covered once.
6. **Pull requests and worktrees.** Filter a fake work queue and a
   fake `git worktree list` to the checked workspaces. Assert the
   payload has no absolute path, no PR body, and no log text.
   `on-your-machine.md` gains the secrets file and the audit log in
   this pull request or in pull request 3, whichever creates the file.

The bridge pull request, in its own repository, is a test that the
five MCP tools map onto the five RPC methods and that an unknown tool
name never becomes a frame. It does not get a sixth tool.

## Review notes

- The security boundary is Studio's role gate plus the redactor, not
  the bridge's tool list. A bridge that forwarded arbitrary RPC would
  still be stopped at `RpcSession`, and that test belongs to pull
  request 2.
- v1 does not enable open or anonymous OAuth client registration.
  Dynamic registration is only the Cursor and Grok Bot redirect URIs
  in [Architecture](#1-architecture), including the published client
  metadata document. A newly registered client has no access until the
  operator approves it on the bridge. A static client id and secret
  remains for a client that cannot register.
- The phone protocol version stays 1. The new methods are additive.
  Phones do not gain the bot redactor.
