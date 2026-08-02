# Codex fast mode investigation

## Conclusion

The composer setting is already global and already reaches both Cora's Pi manager and ordinary Pi workers. The missing behavior is limited to the legacy native Codex worker transports behind `SPARK_E2E_LEGACY_WORKER_HARNESS=1`: the visible Codex CLI command and the Codex app-server automation process do not receive an explicit `fast_mode` override.

The smallest correct change is to resolve `AppSettings.openAiFastMode` once in `launchWorkerAttempt`, after the launch surface is known and immediately before its command or argv is assembled, then thread that boolean only into native Codex worker argument construction. Emit one of these pairs on every native Codex worker process:

```text
--enable fast_mode
--disable fast_mode
```

The explicit false form is required. Omitting the pair when the setting is off would allow a user's `config.toml` value to override Cora's setting.

## Evidence trace

### 1. Composer to global settings

* `src/renderer/src/components/chat/ChatComposer.tsx:907-915` calls `useOpenAiFastMode()` and gates the control by the active GPT model, not by a per-run field. The toggle is rendered at `src/renderer/src/components/chat/ChatComposer.tsx:1198-1200`.
* `src/renderer/src/lib/useOpenAiFastMode.ts:85-103` toggles `AppSettings.openAiFastMode`, saves the entire settings record, and republishes the saved value. Reads and failed writes are fail-closed at `src/renderer/src/lib/useOpenAiFastMode.ts:57-75`.
* The setting is typed as global and documented to cover chat, planning, and workers at `src/shared/types.ts:587-591`. Storage defaults it off and normalizes only literal `true` at `src/main/storage.ts:30-44` and `src/main/storage.ts:205-220`.

### 2. Run creation deliberately does not snapshot fast mode

* `CreateRunInput` includes backend, model, mode, effort, policy, and context, but no fast-mode field at `src/shared/types.ts:3705-3728`.
* `createRunInternal` stamps those chat selections at `src/main/orchestration/run-store.ts:853-945`; it does not read or persist `openAiFastMode`.
* `RunState.chatFastMode` remains legacy and read-only at `src/shared/types.ts:2611-2617`. `resolveChatBackendConfig` explicitly refuses to consult it at `src/main/orchestration/spark-agent-backend.ts:373-380`.

This is the right lifetime. A run created while fast mode is off must still launch a later worker in fast mode if the user turns the global setting on before that worker starts. No `RunState`, `WorkerTask`, or `WorkerAttempt` schema change is needed.

### 3. Existing manager behavior

There are two separate manager paths:

* Native Codex manager: `askManagerBackend` reads current settings for each turn at `src/main/orchestration/run-store.ts:5414-5418`. The Codex-only backend gate is `src/shared/chat-policy.ts:27-45`. `buildCodexManagerArgs` then emits explicit enable or disable at `src/main/orchestration/codex-manager-launch.ts:18-38`. The app-server manager does the same at `src/main/orchestration/codex-backend.ts:699-702`, and a setting change rotates the long-lived native session at `src/main/orchestration/codex-backend.ts:1229-1249`.
* Cora Pi manager: this does not use `ChatBackendConfig.fastMode`, because `effectiveChatFastMode("pi", true)` is intentionally false. Instead, `ensureSession` independently resolves the global setting for the selected Pi provider and includes it in session identity at `src/main/orchestration/pi-backend.ts:258-311`. `resolveCodaraPiFastMode` returns false for Anthropic at `src/main/orchestration/pi-runtime-electron.ts:146-170`.

That distinction is load-bearing: native Codex uses CLI config flags, while Pi uses process environment plus a provider hook.

### 4. Existing Pi worker behavior

Ordinary Cora workers do not launch native Claude or Codex CLIs. `launchWorkerAttempt` selects Pi for both provider labels unless the exact legacy E2E escape hatch is set, at `src/main/orchestration/run-store.ts:12236-12253`. This is pinned by `scripts/test-pi-worker-harness-gate.cjs:4-99`.

For a Pi worker, `runtimePreference: "codex"` means the `openai-codex` provider, not the Codex CLI. `runPiWorkerSession` selects that provider at `src/main/orchestration/run-store.ts:17814-17863` and creates its plan at `src/main/orchestration/run-store.ts:17958-17976`. `createCodaraPiWorkerLaunchPlan` reads the active global setting at plan creation at `src/main/orchestration/pi-runtime-electron.ts:583-647`. The shared Pi builder writes `CODARA_PI_FAST_MODE=1` only for a non-Anthropic provider at `src/main/orchestration/pi-runtime.ts:440-449`. Existing assertions cover off, on, and Anthropic exclusion at `scripts/test-pi-runtime.cjs:326-367`.

No Pi worker change is required.

### 5. Missing native Codex worker behavior

`launchWorkerAttempt` builds the legacy native command at `src/main/orchestration/run-store.ts:12327-12341` and routes either to Pi, structured automation, or the visible CLI session at `src/main/orchestration/run-store.ts:12439-12478`.

The visible Codex CLI builder creates sandbox or `--yolo`, model, and effort args at `src/main/orchestration/run-store.ts:18710-18828`. It never reads the setting and never emits `--enable/--disable fast_mode`.

The structured Codex automation path similarly constructs `codex app-server --stdio` at `src/main/orchestration/structured-worker.ts:273-317`, then spawns it at `src/main/orchestration/structured-worker.ts:317-321`, with no fast-mode override. This path is also native Codex and should be covered if the escape hatch remains supported.

## Smallest correct implementation

1. In `src/main/orchestration/run-store.ts`, inside `launchWorkerAttempt`, immediately after `usePiWorkerHarness` is resolved, compute a fail-closed launch value only for a native Codex worker:

   ```ts
   const nativeCodexFastMode =
     !usePiWorkerHarness && task.runtimePreference === "codex"
       ? await loadSettings().then(
           (settings) => settings.openAiFastMode === true,
           () => false,
         )
       : false;
   ```

   `loadSettings` is already imported in this file. Resolving here gives both native transports one immutable value for this process launch and avoids adding run state.

2. Extend the existing options of `buildLaunchCommandLine` in `src/main/orchestration/run-store.ts` with `openAiFastMode?: boolean`. Pass `nativeCodexFastMode` from the call at `run-store.ts:12327-12332`. In the Codex branch, after selecting the sandbox or `--yolo` base args, append:

   ```ts
   args.push(opts?.openAiFastMode ? "--enable" : "--disable", "fast_mode");
   ```

   Do not add this in the Claude branch or outside the `runtimePreference === "codex"` branch.

3. For the native app-server automation route, add `openAiFastMode: boolean` to `StructuredWorkerInput` in `src/main/orchestration/structured-worker.ts:33-49`. Thread the same resolved value through `runStructuredAutomationWorkerSession` and its `runStructuredWorker` call at `src/main/orchestration/run-store.ts:17329-17430`. In `runCodexWorker`, append the same explicit pair to the app-server `args` before `resolveLaunchTarget` at `src/main/orchestration/structured-worker.ts:297-316`. `runClaudeWorker` must ignore the field.

This is two production files. A shared helper for the two-token pair is optional, but not necessary for correctness.

## Isolation and edge cases

* Claude workers: no flag, no settings read solely for a Claude launch, and no change to Claude command bytes.
* Manual and shell workers: `buildLaunchCommandLine` still returns null. They must not acquire Codex flags.
* Manual Codex terminals: leave `src/renderer/src/workers/launch-commands.ts:1-49` unchanged. Its `CODEX_LAUNCH_COMMAND` and resume command belong to user-driven terminals and do not pass through `launchWorkerAttempt`.
* Default Cora workers: stay on Pi and retain the existing environment-based policy. Do not add Codex CLI flags to the Pi command.
* Setting off or absent: emit `--disable fast_mode`, not nothing. A malformed or unreadable settings file resolves false.
* Setting changes: affect workers whose process has not yet been launched. They do not mutate an already-running worker. Native workers are one attempt per process, so they need no manager-style session identity or respawn logic.
* Legacy `run.chatFastMode`: never consult it, including retries and restored runs.
* Sandboxed Codex: the pair is valid alongside both `--sandbox workspace-write` and `--yolo`; preserve all current access, `--add-dir`, model, and effort args.
* Native account selection: `CODEX_HOME` chooses credentials and config location, but the explicit CLI override remains authoritative for every selected profile.

## Proposed test assertions

Add a focused `scripts/test-codex-worker-fast-mode.cjs`, or extend `scripts/test-composer-fast-mode.cjs` if keeping the source-contract style already used there.

Assert all of the following:

1. A native Codex CLI worker with the setting on contains exactly one adjacent `--enable`, `fast_mode` pair.
2. The same worker with the setting off contains exactly one adjacent `--disable`, `fast_mode` pair.
3. The false case remains explicit even when no model or effort hint is present.
4. Both assertions hold for `--yolo` and sandboxed command variants without changing `--add-dir`, model, or effort arguments.
5. A native Claude CLI worker contains neither `fast_mode` nor `--enable`/`--disable` added by this feature, and its existing command is byte-identical.
6. Manual and shell tasks still return no native launch command.
7. `CODEX_LAUNCH_COMMAND === "codex --yolo"` and `buildCodexResumeCommand(id) === "codex resume <id> --yolo"`, proving manual Codex terminals are unaffected.
8. Structured Codex app-server argv has the explicit on/off pair; structured Claude input produces no Codex flag.
9. A run can be created with fast mode off, then settings can change to on before `launchWorkerAttempt`; the produced native Codex command uses on. This proves launch-time global semantics and guards against accidental run snapshotting.
10. Existing Pi assertions continue to pass: OpenAI Pi gets `CODARA_PI_FAST_MODE=1` only when on, Anthropic never gets it, and default worker routing remains Pi.

Recommended commands after implementation:

```text
node scripts/test-codex-worker-fast-mode.cjs
npm run test:composer-fast-mode
npm run test:pi-worker-harness
npm run test:pi-runtime
npm run typecheck:node
```
