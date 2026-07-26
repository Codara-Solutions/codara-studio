// Executable coverage for the worker failure taxonomy: the classifier that
// turns an attempt's raw error string into a kind, and the retry plan each kind
// earns. Bundles the real src/main/orchestration/failure-taxonomy.ts.
//
//   node scripts/test-failure-taxonomy.cjs
//
// Exits non-zero on any failed assertion.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

const plugin = {
  name: "failure-taxonomy-test-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function loadTaxonomy() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cora-failure-taxonomy-"));
  const outfile = path.join(tmp, "failure-taxonomy.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "failure-taxonomy.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    plugins: [plugin],
    logLevel: "silent",
  });
  return require(outfile);
}

async function main() {
  const {
    classifyWorkerFailure,
    isTransientWorkerFailure,
    planWorkerFailureRetry,
    MAX_SAME_RUNTIME_TRANSIENT_ATTEMPTS,
  } = await loadTaxonomy();

  // Strings taken from the code paths that actually produce them today:
  // worker-launch.ts (launch markers, detectFatalWorkerRuntimeError),
  // pi-runtime.ts / pi-runtime-electron.ts (OAuth), run-store.ts (timeouts,
  // interrupts) and the live OpenAI transient recorded in run-ms0r5cag-v4owkb.
  const cases = [
    // provider
    ["An error occurred while processing your request (request ID: 8824)", "provider"],
    // detectFatalWorkerRuntimeError's auth-specific collapse reason must land
    // in the auth bucket, not provider, or an expired credential buys a doomed
    // same-runtime retry (judge follow-up on the taxonomy track).
    ["runtime authentication failed before final report", "auth"],
    // rate limits are their own kind: never fast-retried on the same runtime
    ["runtime rate limit before final report", "rate_limit"],
    ["HTTP 429 Too Many Requests", "rate_limit"],
    ["usage limit reached for this window", "rate_limit"],
    ["runtime temporarily unavailable before final report", "provider"],
    ["runtime API error before final report", "provider"],
    ["Pi provider turn failed.", "provider"],
    ["Pi exhausted its provider retries.", "provider"],
    ["Request failed with status 503", "provider"],
    // transport
    ["API Error: socket connection was closed unexpectedly", "transport"],
    ["runtime network fetch failure before final report", "transport"],
    ["fetch failed", "transport"],
    ["read ECONNRESET", "transport"],
    // auth
    ["Pi provider anthropic is not authenticated with OAuth", "auth"],
    ["Pi provider openai has no OAuth access token", "auth"],
    ["Pi provider anthropic OAuth session expired and cannot refresh", "auth"],
    ["401 Unauthorized", "auth"],
    ["invalid api key provided", "auth"],
    // launch
    ["runtime binary did not start (saw 'command not found')", "launch"],
    ["no TUI banner observed", "launch"],
    ["launch command returned to shell prompt, agent CLI exited before TUI took over", "launch"],
    ["spawn codex ENOENT", "launch"],
    ["Codara's pinned Pi runtime 0.60.0 is not installed.", "launch"],
    // timeout
    ["Pi worker timed out after 90 minutes.", "timeout"],
    ["Worker timed out after 90 minutes.", "timeout"],
    // tool
    ["Pi worker extension failed.", "tool"],
    ["Codara Pi bridge is incompatible: /tmp/bridge.cjs", "tool"],
    // cancelled
    ["Pi worker was interrupted.", "cancelled"],
    ["The worker was stopped by the user", "cancelled"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyWorkerFailure(text), expected, `classify(${JSON.stringify(text)})`);
  }

  // Unknown text keeps the pre-taxonomy behaviour instead of being forced into
  // a bucket, and empty input is never a failure kind.
  assert.equal(classifyWorkerFailure("the migration script left the schema half applied"), undefined);
  assert.equal(classifyWorkerFailure(""), undefined);
  assert.equal(classifyWorkerFailure("   "), undefined);
  assert.equal(classifyWorkerFailure(undefined), undefined);
  assert.equal(classifyWorkerFailure(null), undefined);

  // A user stop can carry any other error text; control flow still wins.
  assert.equal(
    classifyWorkerFailure("Worker interrupted while the socket connection was closed unexpectedly"),
    "cancelled",
  );
  // The boilerplate writeAutoFailureReport wraps every reason in must not, on
  // its own, look like a launch or auth failure.
  assert.equal(
    classifyWorkerFailure(
      "Verify the CLI is installed, on PATH, and logged in, then re-run.",
    ),
    undefined,
  );

  assert.equal(isTransientWorkerFailure("transport"), true);
  assert.equal(isTransientWorkerFailure("provider"), true);
  assert.equal(isTransientWorkerFailure("auth"), false);
  // Rate limits never earn a fast same-runtime retry: the window outlives it.
  assert.equal(isTransientWorkerFailure("rate_limit"), false);
  assert.equal(isTransientWorkerFailure(undefined), false);

  // Retry policy: transient kinds buy exactly one same-runtime retry, then fall
  // through to the cross-runtime path.
  const firstTransient = planWorkerFailureRetry({
    kind: "provider",
    sameRuntimeAttempts: 1,
    oppositeRuntimeAvailable: true,
  });
  assert.equal(firstTransient.action, "retry_same_runtime");
  const secondTransient = planWorkerFailureRetry({
    kind: "provider",
    sameRuntimeAttempts: MAX_SAME_RUNTIME_TRANSIENT_ATTEMPTS,
    oppositeRuntimeAvailable: true,
  });
  assert.equal(secondTransient.action, "switch_runtime");
  const exhaustedTransient = planWorkerFailureRetry({
    kind: "transport",
    sameRuntimeAttempts: 2,
    oppositeRuntimeAvailable: false,
  });
  assert.equal(exhaustedTransient.action, "no_auto_retry");
  // A transient failure still earns its fast retry when no other runtime is
  // installed at all: the same runtime is the only road left.
  assert.equal(
    planWorkerFailureRetry({ kind: "transport", sameRuntimeAttempts: 1, oppositeRuntimeAvailable: false }).action,
    "retry_same_runtime",
  );

  // Auth, launch, and rate limits keep going straight to the opposite runtime.
  for (const kind of ["auth", "launch", "timeout", "tool", "rate_limit"]) {
    assert.equal(
      planWorkerFailureRetry({ kind, sameRuntimeAttempts: 1, oppositeRuntimeAvailable: true }).action,
      "switch_runtime",
      `${kind} must switch runtime`,
    );
    assert.equal(
      planWorkerFailureRetry({ kind, sameRuntimeAttempts: 1, oppositeRuntimeAvailable: false }).action,
      "no_auto_retry",
      `${kind} without a fallback runtime must not auto retry`,
    );
  }

  // A user stop is never an automatic retry, whatever else is available.
  assert.equal(
    planWorkerFailureRetry({ kind: "cancelled", sameRuntimeAttempts: 1, oppositeRuntimeAvailable: true }).action,
    "no_auto_retry",
  );

  // Unclassified failures behave exactly as the pre-taxonomy code did.
  assert.equal(
    planWorkerFailureRetry({ kind: undefined, sameRuntimeAttempts: 1, oppositeRuntimeAvailable: true }).action,
    "switch_runtime",
  );
  assert.equal(
    planWorkerFailureRetry({ kind: undefined, sameRuntimeAttempts: 1, oppositeRuntimeAvailable: false }).action,
    "no_auto_retry",
  );

  // Every plan explains itself, since the reason is persisted on the run event.
  for (const plan of [firstTransient, secondTransient, exhaustedTransient]) {
    assert.equal(typeof plan.reason, "string");
    assert.ok(plan.reason.length > 0);
  }

  console.log("failure taxonomy: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
