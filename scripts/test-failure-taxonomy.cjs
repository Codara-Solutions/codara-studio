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
    ["Codex error: Our servers are currently overloaded. Please try again later.", "provider"],
    [
      'Claude API Error: 529 {"type":"error","error":{"type":"overloaded_error"},"request_id":"req_secret"}',
      "provider",
    ],
    ["Claude is experiencing high demand; servers are too busy", "provider"],
    // detectFatalWorkerRuntimeError's auth-specific collapse reason must land
    // in the auth bucket, not provider, or an expired credential buys a doomed
    // same-runtime retry (judge follow-up on the taxonomy track).
    ["runtime authentication failed before final report", "auth"],
    // rate limits are their own kind: never fast-retried on the same runtime
    ["runtime rate limit before final report", "rate_limit"],
    ["HTTP 429 Too Many Requests", "rate_limit"],
    ["HTTP 429 Too Many Requests; service unavailable", "rate_limit"],
    ["usage limit reached for this window", "rate_limit"],
    [
      "HTTP 429 Too Many Requests; request timed out after socket ECONNRESET",
      "rate_limit",
    ],
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
    ["HTTP 401 Unauthorized; service unavailable", "auth"],
    ["invalid api key provided", "auth"],
    // launch
    ["runtime binary did not start (saw 'command not found')", "launch"],
    ["no TUI banner observed", "launch"],
    ["launch command returned to shell prompt, agent CLI exited before TUI took over", "launch"],
    ["spawn codex ENOENT", "launch"],
    ["Codara's pinned Pi runtime 0.60.0 is not installed.", "launch"],
    // subscription: billing declines are their own kind, never a quota window.
    // First entry is the exact 400 recorded on run-ms9ikoef-mnucvq's attempt
    // (Anthropic bills third-party harness use against Extra Usage). Ordering
    // matters: rate_limit's "usage limit" and auth's "subscription expired"
    // must never swallow these.
    [
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011Cdavbsxnm5vP5ZkjLrM3t"}',
      "subscription",
    ],
    ["Add more at claude.ai/settings/usage and keep going.", "subscription"],
    ["Your credit balance is too low to access the Anthropic API.", "subscription"],
    ["insufficient credits to complete this request", "subscription"],
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

  // Ordering regression guard: the Extra Usage decline must land in
  // subscription, not in rate_limit (whose pattern contains "usage limit") and
  // not in auth (whose pattern contains "subscription expired"). classify()
  // returns the first match, so equality already proves neither claimed it —
  // these assertions pin the intent explicitly.
  const EXTRA_USAGE_DECLINE =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011Cdavbsxnm5vP5ZkjLrM3t"}';
  assert.equal(classifyWorkerFailure(EXTRA_USAGE_DECLINE), "subscription");
  assert.notEqual(classifyWorkerFailure(EXTRA_USAGE_DECLINE), "rate_limit");
  assert.notEqual(classifyWorkerFailure(EXTRA_USAGE_DECLINE), "auth");
  // And the reverse: an ordinary quota window is still a rate limit, never a
  // billing decline (a bare "usage limit" must not match subscription).
  assert.equal(classifyWorkerFailure("usage limit reached for this window"), "rate_limit");
  assert.equal(classifyWorkerFailure("HTTP 429 Too Many Requests"), "rate_limit");

  assert.equal(isTransientWorkerFailure("transport"), true);
  assert.equal(isTransientWorkerFailure("provider"), true);
  assert.equal(isTransientWorkerFailure("auth"), false);
  // Rate limits never earn a fast same-runtime retry: the window outlives it.
  assert.equal(isTransientWorkerFailure("rate_limit"), false);
  // A billing decline is terminal for the account; a fast retry is a
  // guaranteed second failure.
  assert.equal(isTransientWorkerFailure("subscription"), false);
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

  // A subscription decline never auto-retries ANYWHERE, at any attempt count,
  // with or without another runtime installed: automatic failover on a billing
  // failure is exactly what the user ruled out. The attempt fails carrying the
  // billing reason and the user switches accounts in Settings.
  for (const sameRuntimeAttempts of [0, 1, 2, 5]) {
    for (const oppositeRuntimeAvailable of [true, false]) {
      const plan = planWorkerFailureRetry({
        kind: "subscription",
        sameRuntimeAttempts,
        oppositeRuntimeAvailable,
      });
      assert.equal(
        plan.action,
        "no_auto_retry",
        `subscription must never auto-retry (fallback available: ${oppositeRuntimeAvailable})`,
      );
      // The reason must stay the billing explanation even when a fallback
      // runtime exists, so the failure card never blames a missing runtime.
      assert.match(plan.reason, /subscription or billing state is terminal/);
    }
  }

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
