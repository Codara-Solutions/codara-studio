const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const PROFILE_A = "11111111-1111-4111-8111-111111111111";
const PROFILE_B = "22222222-2222-4222-8222-222222222222";

// Same @shared alias every sibling suite uses: pi-runtime.ts has runtime
// imports from @shared (context-compaction), which esbuild cannot resolve
// without the app's tsconfig paths.
const sharedAliasPlugin = {
  name: "pi-account-execution-shared-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function bundle(entry, outputName) {
  const output = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-account-execution-")),
    outputName,
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [sharedAliasPlugin],
  });
  return require(output);
}

async function main() {
  const execution = await bundle(
    path.join(ROOT, "src/main/orchestration/pi-account-execution.ts"),
    "execution.cjs",
  );
  const runtime = await bundle(
    path.join(ROOT, "src/main/orchestration/pi-runtime.ts"),
    "runtime.cjs",
  );
  const sessionIdentity = await bundle(
    path.join(ROOT, "src/main/orchestration/pi-session-identity.ts"),
    "session-identity.cjs",
  );

  assert.equal(execution.normalizePiAccountProfileId(undefined), undefined);
  assert.equal(execution.normalizePiAccountProfileId(PROFILE_A), PROFILE_A);
  assert.throws(
    () => execution.normalizePiAccountProfileId("../auth.json"),
    /lowercase UUIDv4/,
  );
  assert.equal(
    execution.preserveFrozenPiAccountProfileId(PROFILE_A, undefined),
    PROFILE_A,
  );
  assert.equal(
    execution.preserveFrozenPiAccountProfileId(undefined, PROFILE_A),
    PROFILE_A,
  );
  assert.throws(
    () => execution.preserveFrozenPiAccountProfileId(PROFILE_A, PROFILE_B),
    /changed during a single turn/,
  );

  const selection = execution.normalizePiExecutionAccount(
    {
      provider: "openai-codex",
      preferredAccountProfileId: PROFILE_A,
    },
    {
      accountProfileId: PROFILE_A,
      configDir: "/private/codara/accounts/a",
    },
  );
  assert.deepEqual(selection, {
    accountProfileId: PROFILE_A,
    configDir: "/private/codara/accounts/a",
  });
  assert.throws(
    () =>
      execution.normalizePiExecutionAccount(
        {
          provider: "openai-codex",
          preferredAccountProfileId: PROFILE_A,
        },
        {
          accountProfileId: PROFILE_B,
          configDir: "/private/codara/accounts/b",
        },
      ),
    /did not honor the pinned profile/,
  );
  assert.throws(
    () =>
      execution.normalizePiExecutionAccount(
        { provider: "anthropic" },
        { configDir: "relative/account" },
      ),
    /absolute path/,
  );
  assert.equal(
    execution.selectPiWorkerAccountProfile({
      persistedAttemptProfileId: PROFILE_B,
      runManagerProfileId: PROFILE_A,
      runManagerProvider: "openai-codex",
      workerProvider: "openai-codex",
    }),
    PROFILE_B,
  );
  assert.equal(
    execution.selectPiWorkerAccountProfile({
      runManagerProfileId: PROFILE_A,
      runManagerProvider: "openai-codex",
      workerProvider: "openai-codex",
    }),
    PROFILE_A,
  );
  assert.equal(
    execution.selectPiWorkerAccountProfile({
      runManagerProfileId: PROFILE_A,
      runManagerProvider: "openai-codex",
      workerProvider: "anthropic",
    }),
    undefined,
  );

  // A provider billing decline must NOT reroute anything: there is no
  // declined-account state, so the manager's account is inherited exactly as
  // before and the failing account keeps serving until the user switches
  // accounts in Settings. The run fails visibly instead.
  const runStoreSelectionSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "orchestration", "run-store.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    runStoreSelectionSource,
    /isAccountUnavailable|PiAccountSubscriptionDecline|isPiAccountTemporarilyUnavailable/,
    "run-store must not mark or consult declined accounts for failover",
  );
  assert.equal(
    fs.existsSync(
      path.join(ROOT, "src", "main", "orchestration", "pi-account-availability.ts"),
    ),
    false,
    "the declined-account failover module must stay deleted",
  );
  assert.match(
    runStoreSelectionSource,
    /if \(!workerAccountProfileId\) \{[\s\S]{0,200}?rankImplicitPiAccounts\(/,
    "an unset selection must fall through to implicit ranking",
  );
  assert.equal(
    execution.selectPiWorkerAccountProfile({
      runManagerProfileId: PROFILE_A,
      runManagerProvider: "anthropic",
      workerProvider: "anthropic",
    }),
    PROFILE_A,
    "inheritance is unconditional — no billing state can divert it",
  );

  const plan = runtime.buildPiManagerLaunchPlan({
    runtime: {
      packageRoot: "/runtime",
      packageJsonPath: "/runtime/package.json",
      entrypoint: "/runtime/cli.js",
      version: runtime.CODARA_PI_VERSION,
    },
    provider: "openai-codex",
    accountProfileId: PROFILE_A,
    configDir: "/private/codara/accounts/a",
    sessionDir: "/private/codara/sessions",
    sessionId: "session-a",
    runId: "run-a",
    mode: "talk",
    cwd: "/workspace",
    bridgePath: "/resources/bridge.js",
    extensionPaths: ["/resources/extension.ts"],
    baseEnv: {
      OPENAI_API_KEY: "must-not-leak",
      PATH: "/usr/bin",
    },
  });
  assert.equal(plan.accountProfileId, PROFILE_A);
  assert.equal(plan.env.PI_CODING_AGENT_DIR, "/private/codara/accounts/a");
  assert.equal(
    plan.env.PI_CODING_AGENT_SESSION_DIR,
    "/private/codara/sessions",
  );
  assert.equal(plan.env.OPENAI_API_KEY, undefined);
  assert.equal(JSON.stringify(plan).includes("must-not-leak"), false);

  const baseSession = {
    provider: "openai-codex",
    accountProfileId: PROFILE_A,
    model: "gpt-5.6-sol",
    thinking: "high",
    mode: "execute",
    chatMode: "auto",
    executionPolicy: "fast",
    projectPolicyMode: "trusted",
    sessionId: "session-a",
    fastMode: false,
  };
  assert.equal(
    sessionIdentity.piBackendSessionIdentityMatches(baseSession, {
      ...baseSession,
    }),
    true,
  );
  assert.equal(
    sessionIdentity.piBackendSessionIdentityMatches(baseSession, {
      ...baseSession,
      accountProfileId: PROFILE_B,
    }),
    false,
  );
  assert.equal(
    sessionIdentity.piBackendSessionIdentityMatches(baseSession, {
      ...baseSession,
      projectPolicyMode: "untrusted-pull-request",
    }),
    false,
  );
  // Fast mode is launch-time env, so it is as process-significant as the model:
  // reusing a session across a flip would apply the composer's toggle to
  // nothing at all.
  assert.equal(
    sessionIdentity.piBackendSessionIdentityMatches(baseSession, {
      ...baseSession,
      fastMode: true,
    }),
    false,
  );
  const legacySession = { ...baseSession };
  delete legacySession.accountProfileId;
  assert.equal(
    sessionIdentity.piBackendSessionIdentityMatches(legacySession, {
      ...legacySession,
    }),
    true,
  );

  const runStoreSource = fs.readFileSync(
    path.join(ROOT, "src/main/orchestration/run-store.ts"),
    "utf8",
  );
  const managerStart = runStoreSource.indexOf(
    "const chatConfig = await freezeManagerExecutionAccount(",
  );
  const managerPin = runStoreSource.lastIndexOf(
    "run = await pinImplicitPiManagerAccount(run);",
    managerStart,
  );
  const managerCall = runStoreSource.indexOf(
    "const sparkCall: SparkCall = {",
    managerStart,
  );
  const managerPersist = runStoreSource.indexOf(
    "const preparedTurn = await prepareManagerTurn(run, sparkCall);",
    managerCall,
  );
  assert.ok(managerPin >= 0 && managerPin < managerStart);
  assert.ok(managerStart < managerCall);
  assert.ok(managerCall < managerPersist);
  assert.match(
    runStoreSource.slice(managerCall, managerPersist),
    /accountProfileId: chatConfig\.accountProfileId/,
  );

  const workerStart = runStoreSource.indexOf(
    "async function runPiWorkerSession(",
  );
  const workerEnd = runStoreSource.indexOf(
    "async function runWorkerSession(",
    workerStart,
  );
  const workerSource = runStoreSource.slice(workerStart, workerEnd);
  const accountResolved = workerSource.indexOf(
    "const resolvedWorkerAccount = await resolveCodaraPiExecutionAccount({",
  );
  const profilePersisted = workerSource.indexOf(
    "await stampAttemptAccountProfile(",
    accountResolved,
  );
  const planCreated = workerSource.indexOf(
    "const plan = await createCodaraPiWorkerLaunchPlan({",
    profilePersisted,
  );
  const cleanupCaptured = workerSource.indexOf(
    "mcpConfigPath = plan.mcpConfigPath;",
    planCreated,
  );
  const processStarted = workerSource.indexOf(
    "await client.start();",
    cleanupCaptured,
  );
  assert.ok(accountResolved >= 0 && accountResolved < profilePersisted);
  assert.ok(profilePersisted < planCreated);
  assert.ok(planCreated < cleanupCaptured);
  assert.ok(cleanupCaptured < processStarted);
  assert.match(
    workerSource.slice(planCreated, cleanupCaptured),
    /resolvedAccount: resolvedWorkerAccount/,
  );

  console.log(
    "PASS Pi account execution identity, session reuse key, pinning, and launch isolation",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
