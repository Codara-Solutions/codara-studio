# Claude fast mode investigation: propagating Cora's OpenAI fast mode to native Codex workers

Independent read-only investigation. No source code was changed. Evidence is file and line
references against the working tree at commit `0d9382d`, plus read-only probes of the locally
installed `codex-cli 0.146.0`.

## Answer in one paragraph

Two different things are called "fast mode" in this repo and they must not be conflated.
Cora Pi fast mode is a process environment variable (`CODARA_PI_FAST_MODE=1`) consumed by the
bundled Pi extension, which rewrites the provider request body to `service_tier: "priority"`.
Native Codex fast mode is a Codex CLI feature flag (`--enable fast_mode` / `--disable fast_mode`,
equivalent to `-c features.fast_mode=<bool>`) resolved by the Codex binary itself. The composer
setting already reaches every Pi session, manager and worker alike, and it already reaches the
native Codex manager. The only surfaces that do not honor it are the two native Codex WORKER
transports, both of which live behind `SPARK_E2E_LEGACY_WORKER_HARNESS=1`. The smallest correct
fix resolves `AppSettings.openAiFastMode` once inside `launchWorkerAttempt` and threads it into
exactly those two argv builders as an explicit enable-or-disable pair, mirroring
`buildCodexManagerArgs`.

## Checklist this report has to satisfy

1. Trace the value from the composer to a spawned Codex worker process. Done in section 2.
2. Name the smallest correct implementation with exact files and symbols. Section 4.
3. Distinguish Cora Pi fast mode from native Codex CLI worker launch behavior. Sections 1 and 3.
4. Explain how Claude workers and manual Codex terminals stay untouched. Section 5.
5. Edge cases and proposed test assertions. Sections 6 and 7.

## 1. The two fast modes are different mechanisms

| | Cora Pi fast mode | Native Codex fast mode |
| --- | --- | --- |
| Carrier | env `CODARA_PI_FAST_MODE=1` on the Pi child process | CLI argv `--enable fast_mode` / `--disable fast_mode` |
| Stamped by | `buildPiManagerLaunchPlan`, `src/main/orchestration/pi-runtime.ts:447-449` | `buildCodexManagerArgs`, `src/main/orchestration/codex-manager-launch.ts:37`; `codexAppServerArgs`, `src/main/orchestration/codex-backend.ts:699-701` |
| Consumed by | bundled extension `resources/pi-cora/service-tier.ts:61-62` and `:83-101`, which sets `service_tier: "priority"` on the outgoing body | the Codex binary, which resolves `features.fast_mode` from argv then `config.toml` |
| Provider gate | `pi-runtime.ts:447` refuses the flag whenever `provider === "anthropic"` | none needed: a Codex process is always OpenAI |
| Backend gate | none; Pi resolves the setting itself per session | `chatBackendSupportsFastMode(backend) === (backend === "codex")`, `src/shared/chat-policy.ts:27-29` |

The asymmetry is deliberate and documented at `resources/pi-cora/service-tier.ts:14-25`: OpenAI is
opt in, Anthropic is structurally stripped. `OPENAI_FAST_SERVICE_TIER` is `"priority"` on purpose
(`resources/pi-cora/service-tier.ts:36-46`); do not "fix" it to `"fast"`.

## 2. Trace: composer setting to a spawned worker

### 2a. Composer to persisted global setting

* `src/renderer/src/components/chat/ChatComposer.tsx:913-914` reads `useOpenAiFastMode()` and
  computes `fastModeAvailable = chatModelIsOpenAi(activeChatModelId)`; the button renders only
  under that gate at `:1198-1199`.
* `src/renderer/src/lib/useOpenAiFastMode.ts:63-105` reads and flips
  `AppSettings.openAiFastMode`, saves the whole settings record, and republishes what main
  actually persisted. Reads are fail closed: an unreadable settings file reports OFF.
* `src/shared/types.ts:585-591` types the field and states its intended blast radius in prose:
  "every Cora session that runs on a GPT model: chat, planning, and workers". Workers are in
  scope by design.
* `src/main/storage.ts:43` defaults it to `false` and `:219` normalizes it with `=== true`, so a
  corrupt or absent value can never buy the 2x tier.

There is no per-run snapshot. `resolveChatBackendConfig` refuses to consult the legacy
`run.chatFastMode` even as a fallback (`src/main/orchestration/spark-agent-backend.ts:373-379`),
so the live setting is authoritative at every launch.

### 2b. Manager turn (already correct, both backends)

* `src/main/orchestration/run-store.ts:5417` passes `settings.openAiFastMode === true` into
  `resolveChatBackendConfig`.
* `src/main/orchestration/spark-agent-backend.ts:379` narrows it with
  `effectiveChatFastMode(backend, ...)`, which is true only for the `codex` chat backend
  (`src/shared/chat-policy.ts:27-45`).
* Native Codex manager argv: `src/main/orchestration/codex-manager-launch.ts:36-37` and
  `src/main/orchestration/codex-backend.ts:699-701`. A mid-chat flip is detected as session
  identity drift and forces a dispose-and-respawn-with-resume:
  `src/main/orchestration/codex-backend.ts:66-70` (`spawnFastMode`), `:375`, `:1229-1244`.
* Pi manager: `effectiveChatFastMode("pi", true)` is false by design, so `pi-backend.ts` resolves
  the setting independently per turn at `src/main/orchestration/pi-backend.ts:267-276`
  (`resolveCodaraPiFastMode(provider)`), folds it into session identity at `:291` and
  `src/main/orchestration/pi-session-identity.ts:27,46`, and hands the same value back to the
  launch plan at `pi-backend.ts:311`.

### 2c. Worker spawn: which harness actually runs

`src/main/orchestration/run-store.ts:12245-12248`:

```ts
const usePiWorkerHarness =
  (untrustedPullRequest ||
    process.env.SPARK_E2E_LEGACY_WORKER_HARNESS !== "1") &&
  (task.runtimePreference === "claude" || task.runtimePreference === "codex");
```

So by default every `claude` and `codex` worker is a Pi session, not a native CLI.
`src/main/orchestration/pi-worker-providers.ts:6-13,31-34` states the same contract:
`runtimePreference` is a PROVIDER selector, `codex` means `openai-codex`.
`piProviderForWorker` at `run-store.ts:17476-17478` implements it.

Dispatch is at `run-store.ts:12441-12467`:

| Condition | Transport | Fast mode today |
| --- | --- | --- |
| `usePiWorkerHarness` (default) | `runPiWorkerSession`, `run-store.ts:17821`, plan built at `:17964` | HONORED, see 2d |
| legacy env + automation run | `runStructuredAutomationWorkerSession` -> `runStructuredWorker` -> `runCodexWorker`, `src/main/orchestration/structured-worker.ts:273-316` | MISSING |
| legacy env, everything else | `runWorkerSession` with `buildLaunchCommandLine`, `run-store.ts:12327` and `:18710`, codex branch `:18780-18829` | MISSING |

### 2d. Pi workers already honor it

`src/main/orchestration/pi-runtime-electron.ts:646` inside `createCodaraPiWorkerLaunchPlan`:

```ts
openAiFastMode: await openAiFastModeEnabled(),
```

`openAiFastModeEnabled` (`pi-runtime-electron.ts:150-156`) is the fail-closed reader. The call
site in run-store (`:17964`) passes no `openAiFastMode`, so the plan builder is the single source.
The Anthropic safety comes from the plan builder, not from the worker call site:
`pi-runtime.ts:447` stamps `CODARA_PI_FAST_MODE` only when `provider !== "anthropic"`, and a
Claude worker resolves to `provider === "anthropic"`. That is why a Claude Pi worker is already
immune with no extra branch.

### 2e. The gap, precisely

Native Codex worker processes receive no `fast_mode` argument at all:

* `run-store.ts:18780-18829` (visible Codex CLI worker): pushes `--yolo` or `--sandbox`, `-a never`,
  `--add-dir`, `-m`, and `-c model_reasoning_effort=...`. No `fast_mode`.
* `structured-worker.ts:297-312` (`codex app-server --stdio` automation worker): pushes
  `project_doc_max_bytes=0` and the MCP env overrides. No `fast_mode`.

Both then inherit whatever the resolved `CODEX_HOME` config says, which is exactly the failure
mode `codex-manager-launch.ts:36` calls out: "Make the composer's Fast choice authoritative
regardless of config.toml."

## 3. Probe evidence from the installed Codex CLI

Read-only probes, `codex-cli 0.146.0`:

```
$ codex --help
      --enable <FEATURE>    Enable a feature (repeatable). Equivalent to `-c features.<name>=true`
      --disable <FEATURE>   Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

$ codex app-server --help
      (same --enable / --disable / -c options)

$ codex features list | grep fast_mode
fast_mode                            stable             true

$ TMPH=$(mktemp -d); CODEX_HOME="$TMPH" codex features list | grep fast_mode
fast_mode                            stable             true

$ codex features list -c 'features.fast_mode=false' | grep fast_mode
fast_mode                            stable             false

$ codex features list --enable definitely_not_a_feature
Error: Unknown feature flag: definitely_not_a_feature      (exit 1)
```

Three load-bearing facts:

1. `--enable` / `--disable` are accepted by both the interactive CLI and `app-server`, so one flag
   pair covers both native worker transports.
2. On a COMPLETELY EMPTY `CODEX_HOME`, `fast_mode` is effectively `true`. A native Codex worker
   launched without an explicit flag therefore defaults ON. Omitting the flag when the setting is
   off is not a no-op, it silently spends the user's money. The explicit `--disable` half of the
   pair is the load-bearing half.
3. An unknown feature name is a hard launch failure, which is the main new failure mode a very old
   Codex CLI would hit. See section 6.

## 4. Smallest correct implementation

Four edits, no schema change, no new run or attempt field.

**(1) A shared pure helper.** `src/main/orchestration/worker-access.ts` is already the
"dependency-free module so buildLaunchCommandLine (run-store) and the wave launcher can share the
exact mapping the test harness exercises in isolation" (`worker-access.ts:1-5`), it already hosts
`codexAccessFlags`, and it is already bundled standalone by `scripts/test-worker-access.cjs`. Add:

```ts
/** The explicit Codex feature-flag pair for one native Codex WORKER launch.
 *  Always both halves: an omitted flag lets the resolved CODEX_HOME config
 *  decide, and fast_mode defaults ON in codex-cli. */
export function codexFastModeArgs(fastMode: boolean): [string, string] {
  return [fastMode === true ? "--enable" : "--disable", "fast_mode"];
}
```

Placing it here, rather than in `codex-manager-launch.ts`, keeps the manager module manager-only
and gives the new behavior a bundleable test host on day one.

**(2) Resolve the setting once, at the launch seam.** In `launchWorkerAttempt`
(`run-store.ts:12222`), before `buildLaunchCommandLine` at `:12327`, resolve it fail closed for
native Codex launches only:

```ts
const nativeCodexFastMode =
  !usePiWorkerHarness && task.runtimePreference === "codex"
    ? await loadSettings().then((s) => s.openAiFastMode === true).catch(() => false)
    : false;
```

`loadSettings` is already imported by run-store (used at `:11979` and `:12555`). Gating the read
on the native path keeps the default Pi path byte identical, including its I/O profile.

**(3) Visible Codex CLI worker.** In `buildLaunchCommandLine`, add
`openAiFastMode?: boolean` to the `opts` object (`run-store.ts:18713-18718`) and, inside the
`task.runtimePreference === "codex"` branch, push the pair immediately after the effort override
at `:18817-18818` and before the shield prefix is computed at `:18827`:

```ts
args.push(...codexFastModeArgs(opts?.openAiFastMode === true));
```

Ordering is free: `--enable <FEATURE>` takes exactly one value and is not variadic, so it cannot
swallow a following flag the way Claude's `--disallowedTools` can.

**(4) Codex app-server automation worker.** Add `openAiFastMode?: boolean` to
`StructuredWorkerInput` (`structured-worker.ts:33-50`), pass it from
`runStructuredAutomationWorkerSession` (`run-store.ts:12453-12466` and the
`runStructuredWorker({...})` call at `run-store.ts:17413-17425`), and push the pair into the argv
array at `structured-worker.ts:297-312`, mirroring `codexAppServerArgs`
(`codex-backend.ts:699-701`) exactly. Do not touch `runClaudeWorker`.

### Why not the alternatives

* Do not persist the value on `WorkerAttempt`. `nativeCodexProfileId` is frozen
  (`src/shared/types.ts:3411-3415`, stamped at `run-store.ts:11993-12002`) because switching
  accounts mid-attempt would corrupt identity. Fast mode has no such invariant: a worker process
  is one shot, and a relaunch re-reading the current setting is the same semantics the Pi worker
  already has.
* Do not route it through `ChatBackendConfig.fastMode`. That object is the MANAGER turn contract
  and is gated by `chatBackendSupportsFastMode`, which is false for the Pi backend that spawns
  most workers. Reusing it would make worker fast mode depend on which manager backend the user
  chose, which is wrong.
* Do not add a `WorkerTask` hint. Fast mode is a global user setting, not a manager decision, and
  letting the manager LLM emit it would hand a model the power to spend 2x.

## 5. Blast radius: what must not change

* **Claude workers, Pi path.** Untouched by construction: `pi-runtime.ts:447` already refuses the
  env stamp for `provider === "anthropic"`, and the new code never reaches `buildPiManagerLaunchPlan`.
* **Claude workers, native path.** The `claude` branch of `buildLaunchCommandLine`
  (`run-store.ts:18731-18779`) and `runClaudeWorker` (`structured-worker.ts:121-265`) must not
  receive the pair. The Claude CLI has no `--enable` flag; passing it would trip the launch
  failure markers in `src/main/orchestration/worker-launch.ts:63-72` and fail the worker outright.
  Keeping the push inside the existing `task.runtimePreference === "codex"` branch is the whole
  guarantee.
* **Manual and standing Codex terminals.** Do not touch
  `buildStandingTerminalCommand` (`run-store.ts:7624-7651`),
  `codexProvider.buildArgs` / `buildResumeArgs` / `recommendedWorkerCommand`
  (`src/main/providers/codex.ts:74-115`), or the renderer's
  `CODEX_LAUNCH_COMMAND` and `buildCodexResumeCommand`
  (`src/renderer/src/workers/launch-commands.ts:7,48`). Those are sessions the human drives, and
  the human's own `~/.codex/config.toml` is the correct authority there. A user-facing
  Cora setting silently rewriting a terminal the user opened themselves would be a surprise, and
  it would also change the string `isAgentSessionLaunchCommand`
  (`launch-commands.ts:30-37`) prefix matches for session restore.
* **Codex chat backend.** Already correct. Adding a second write path would risk diverging from
  the `spawnFastMode` respawn check at `codex-backend.ts:1229-1244`.

## 6. Edge cases

1. **Default-on is the real bug.** Probe 2 above: the flag pair must be emitted in BOTH states.
   A "only push when enabled" implementation leaves fast mode on for every native Codex worker.
2. **Old Codex CLI.** `Error: Unknown feature flag` is fatal (exit 1). For the pty worker this
   surfaces as the shell-integration `OSC 633;D` path in
   `worker-launch.ts:96-103` ("launch command returned to shell prompt"), not as a recognized
   failure marker, because `Unknown feature flag` is absent from the marker list at
   `worker-launch.ts:63-72`. The manager already takes this risk today
   (`codex-manager-launch.ts:37`), so parity is defensible, but consider adding
   `"Unknown feature flag"` to that marker list so the failure is fast and legible rather than a
   12s timeout. That is a separate, optional follow-up, not part of the minimal change.
3. **Untrusted pull-request runs.** `usePiWorkerHarness` forces Pi for those
   (`run-store.ts:12245-12248`), and the native profile freeze is gated on
   `runProjectPolicyMode(run) === "trusted"` (`run-store.ts:11993-11999`). The native Codex worker
   path is therefore unreachable on untrusted PRs and needs no extra guard.
4. **Mid-run flips.** A worker is one shot. A flip between two workers in the same batch means
   worker A ran normal and worker B runs fast. That matches the Pi worker behavior today and is
   the intended "takes effect on the next launch" semantics documented at
   `useOpenAiFastMode.ts:57-62`.
5. **Settings read failure.** Must be fail closed to `false`, matching
   `pi-runtime-electron.ts:146-156`. Never let a thrown read abort the launch, and never let it
   default ON.
6. **The persisted display string changes.** `attempt.command` becomes
   `pwsh -> cd '<cwd>'; codex --yolo -m ... --disable fast_mode`
   (`run-store.ts:12337-12341`). Any e2e assertion on that string needs review; today's
   `tests/e2e/cora-chat-polish.spec.ts:479` only asserts the MANAGER call does not contain
   `--yolo`, so it is unaffected.
7. **Cost accounting.** `estimateWorkerCostUsd` prices by model, not by service tier
   (`structured-worker.ts:426` call site), so a fast-mode worker will be under-reported by the
   priority multiplier. Pre-existing for Pi workers too; worth a follow-up, out of scope here.

## 7. Proposed test assertions

### A. `scripts/test-worker-access.cjs` (extend, pure and bundleable, 60 checks green today)

```js
eq("fast mode on enables the Codex feature", wa.codexFastModeArgs(true), ["--enable", "fast_mode"]);
eq("fast mode off emits an EXPLICIT disable", wa.codexFastModeArgs(false), ["--disable", "fast_mode"]);
eq("a missing setting fails closed to disable", wa.codexFastModeArgs(undefined), ["--disable", "fast_mode"]);
ok("the pair is never omitted", wa.codexFastModeArgs(false).length === 2);
ok("no Claude equivalent exists", typeof wa.claudeFastModeArgs === "undefined");
```

Command: `node scripts/test-worker-access.cjs`.

### B. New `scripts/test-codex-worker-fast-mode.cjs` (source-text, the style of `scripts/test-composer-fast-mode.cjs`)

`run-store.ts` and `structured-worker.ts` both import `electron`, so they cannot be bundled and
executed in a `.cjs` harness. Assert on source text, exactly as the existing fast-mode test does
for `pi-backend.ts` and `pi-runtime-electron.ts`
(`scripts/test-composer-fast-mode.cjs:76-83`):

```js
const runStore = read("src/main/orchestration/run-store.ts");
const structured = read("src/main/orchestration/structured-worker.ts");
const providersCodex = read("src/main/providers/codex.ts");
const launchCommands = read("src/renderer/src/workers/launch-commands.ts");

// The native Codex WORKER carries the pair.
assert.match(runStore, /args\.push\(\.\.\.codexFastModeArgs\(opts\?\.openAiFastMode === true\)\)/);
assert.match(structured, /codexFastModeArgs\(input\.openAiFastMode === true\)/);

// The claude branch of buildLaunchCommandLine never sees it.
const claudeBranch = runStore.slice(
  runStore.indexOf('if (task.runtimePreference === "claude") {'),
  runStore.lastIndexOf('if (task.runtimePreference === "codex") {'),
);
assert.doesNotMatch(claudeBranch, /fast_mode/);

// Manual and standing terminals stay the user's own config.
assert.doesNotMatch(providersCodex, /fast_mode/);
assert.doesNotMatch(launchCommands, /fast_mode/);
const standing = runStore.slice(
  runStore.indexOf("function buildStandingTerminalCommand("),
  runStore.indexOf("function standingTerminalTitle("),
);
assert.doesNotMatch(standing, /fast_mode/);

// Fail closed: the launch-seam read cannot throw the launch, and cannot default ON.
assert.match(runStore, /openAiFastMode === true[\s\S]{0,120}catch\(\(\) => false\)/);
```

### C. Regression guards to re-run unchanged (all green at baseline)

| Command | Proves |
| --- | --- |
| `node scripts/test-composer-fast-mode.cjs` | the composer, the global setting, and the Pi manager identity path are untouched |
| `node scripts/test-codex-manager-session.cjs` | `buildCodexManagerArgs` still emits the manager pair for both states |
| `node scripts/test-worker-access.cjs` | the codex access-flag mapping did not shift |
| `npm run typecheck:node` | the new `opts` and `StructuredWorkerInput` fields type check |

### D. Optional live probe for whoever implements it

```
codex features list --enable fast_mode  | grep fast_mode   # -> true
codex features list --disable fast_mode | grep fast_mode   # -> false
```

That is the cheapest end-to-end proof that the exact argv Codara will emit resolves the feature
the way the implementation assumes, without spending a token.

## 8. Open questions and risks

* Whether `features.fast_mode = true` alone bills the priority tier, or whether Codex also
  consults `service_tier` in `config.toml`, is not determinable read-only from this machine.
  Codara's manager already treats the feature flag as the authoritative expression of the user's
  choice (`codex-manager-launch.ts:36-37`), so worker parity is the consistent answer regardless.
* The two native Codex worker transports only run under `SPARK_E2E_LEGACY_WORKER_HARNESS=1`
  today. The change is therefore low blast radius but also low current impact. It is worth doing
  because the flag is an e2e escape hatch that can be flipped at any time, and because the
  default-ON probe result means the current silence is not neutral.
* `mapCodexEffort` and model hints already flow into the same argv builders, so a future
  refactor that extracts the whole native Codex worker argv into a pure module (the
  `codex-manager-launch.ts` precedent) would make all of section 7B testable as real argv rather
  than source text. That is a larger change than this task warrants.
