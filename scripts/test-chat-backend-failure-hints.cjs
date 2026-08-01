"use strict";

// Execute the real pure helper straight from ChatConversation without loading
// React/Virtuoso. This keeps the UX taxonomy pinned while leaving the component
// as the only production file in scope.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_PATH = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "components",
  "chat",
  "ChatConversation.tsx",
);
const REMOTE_ACCESS_PATH = path.join(
  ROOT,
  "src",
  "main",
  "remote-access",
  "production.ts",
);

async function loadHelper() {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const start = source.indexOf("function backendFailureDetails");
  const end = source.indexOf("\nfunction BackendFailureMessage", start);
  assert.notEqual(start, -1, "backendFailureDetails must exist");
  assert.notEqual(end, -1, "BackendFailureMessage boundary must exist");
  const result = await esbuild.transform(
    `${source.slice(start, end)}\nexport { backendFailureDetails };`,
    { loader: "tsx", format: "cjs", target: "node20" },
  );
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", result.code)(mod, mod.exports);
  return mod.exports.backendFailureDetails;
}

async function loadDuplicateFilter() {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const start = source.indexOf("function timelineSparkCallId");
  const end = source.indexOf("\nfunction groupCompletedActivity", start);
  assert.notEqual(start, -1, "timelineSparkCallId must exist");
  assert.notEqual(end, -1, "duplicate-filter boundary must exist");
  const result = await esbuild.transform(
    `${source.slice(start, end)}\nexport { isRedundantParkedBackendFailure };`,
    { loader: "tsx", format: "cjs", target: "node20" },
  );
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", result.code)(mod, mod.exports);
  return mod.exports.isRedundantParkedBackendFailure;
}

async function loadRemoteProjectionHelpers() {
  const source = fs.readFileSync(REMOTE_ACCESS_PATH, "utf8");
  const start = source.indexOf("const LEGACY_CORA_BACKEND_FAILURE");
  const end = source.indexOf("\nfunction toRemoteRun(", start);
  assert.notEqual(start, -1, "legacy remote failure sanitizer must exist");
  assert.notEqual(end, -1, "remote helper boundary must exist");
  const result = await esbuild.transform(
    `${source.slice(start, end)}\nexport { publicRemoteCoraMessage, remoteCoraSourceMessages };`,
    { loader: "ts", format: "cjs", target: "node20" },
  );
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", result.code)(mod, mod.exports);
  return mod.exports;
}

async function main() {
  const details = await loadHelper();
  const isRedundantParkedBackendFailure = await loadDuplicateFilter();
  const remote = await loadRemoteProjectionHelpers();

  for (const failure of [
    "Cora Pi backend error: rate limit reached",
    "Cora Pi backend error: HTTP 429 Too Many Requests",
    "Cora Pi backend error: insufficient_quota",
    "Cora Pi backend error: usage-limit exceeded",
    "Codex backend error: rate limit reached",
    "Codex backend error: HTTP 429 Too Many Requests",
    "Claude Code backend error: quota exhausted",
    "Claude Code backend error: usage-limit exceeded",
  ]) {
    assert.equal(details(failure)?.kind, "quota", failure);
  }
  // Billing / Extra Usage declines are their own kind, tested BEFORE both auth
  // and quota — the same precedence failure-taxonomy.ts gives `subscription`.
  // An envelope carrying a billing phrase alongside an auth-ish or quota-ish
  // word must not park as "subscription" in main while rendering an auth or
  // quota card here, and must never promise a reset that never comes.
  for (const failure of [
    'Cora Pi backend error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}',
    "Cora Pi backend error: your credit balance is too low to access the API",
    "Cora Pi backend error: billing issue: extra usage exhausted, please log in again",
    "Cora Pi backend error: extra usage exhausted (usage limit)",
  ]) {
    assert.equal(details(failure)?.kind, "billing", failure);
  }
  assert.match(
    details(
      'Cora Pi backend error: 400 {"error":{"message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}',
    )?.hint ?? "",
    /Extra Usage/,
    "the billing hint names Extra Usage in the Settings note's terminology",
  );
  // Ordinary auth and quota envelopes are unaffected by that reordering.
  assert.equal(
    details("Cora Pi backend error: OAuth session expired")?.kind,
    "auth",
  );
  assert.equal(
    details("Cora Pi backend error: usage-limit exceeded")?.kind,
    "quota",
  );

  // Quota failures render one unconditional Settings-facing hint: account
  // choice is no longer a per-chat action, so the message always points at
  // the provider's active account in Settings.
  const conversationSourceForHint = fs.readFileSync(SOURCE_PATH, "utf8");
  assert.match(
    conversationSourceForHint,
    /Switch the active account for this provider in Settings, or wait for this account’s usage limit to reset, then retry this message\./,
    "the quota failure hint must point at Settings unconditionally",
  );

  const legacyCapacityMessage = {
    id: "message-capacity",
    author: "spark",
    kind: "status",
    message:
      'Claude Code backend error: API Error 529 {"request_id":"req_secret","token":"secret_token"}',
    createdAt: "2026-07-31T10:00:00.000Z",
  };
  const publicCapacity = remote.publicRemoteCoraMessage(legacyCapacityMessage);
  assert.match(publicCapacity, /temporarily unavailable or at capacity/i);
  assert.match(publicCapacity, /retry.*switch accounts/i);
  assert.doesNotMatch(publicCapacity, /req_secret|secret_token|request_id/);

  const ordinaryMessage = {
    ...legacyCapacityMessage,
    id: "message-user",
    author: "user",
    kind: "instruction",
    message: "Please continue",
  };
  const projectedWithoutRecovery = remote.remoteCoraSourceMessages({
    humanMessages: [ordinaryMessage, legacyCapacityMessage],
  });
  assert.equal(projectedWithoutRecovery.length, 2);
  assert.equal(projectedWithoutRecovery[0].message, "Please continue");
  assert.doesNotMatch(projectedWithoutRecovery[1].message, /req_secret|secret_token/);

  const projectedWithRecovery = remote.remoteCoraSourceMessages({
    humanMessages: [ordinaryMessage, legacyCapacityMessage],
    managerTurnRecovery: {
      id: "recovery-current",
      state: "parked",
      failureKind: "provider",
    },
  });
  assert.deepEqual(
    projectedWithRecovery.map((message) => message.id),
    ["message-user"],
    "the recovery projection is authoritative and legacy error dialogue is not duplicated",
  );

  const overload = details(
    "Cora Pi backend error: Our servers are currently overloaded. Please try again later.",
  );
  assert.match(overload.detail, /temporarily unavailable or at capacity/i);
  assert.match(overload.hint, /retry.*saved turn/i);
  assert.match(overload.hint, /switch.*account/i);
  assert.doesNotMatch(overload.hint, /sign-in|log ?in|reconnect/i);
  assert.equal(overload.kind, "capacity");

  const genericPi = details("Cora Pi backend error: unexpected response shape");
  assert.match(genericPi.hint, /Retry this message/);
  assert.doesNotMatch(genericPi.hint, /sign-in|log ?in|reconnect/i);
  assert.doesNotMatch(genericPi.hint, /account picker/);
  assert.equal(genericPi.kind, "other");

  for (const failure of [
    "Cora Pi backend error: provider returned 401 Unauthorized",
    "Codex backend error: OAuth session expired; please login again",
    "Claude Code backend error: credentials are invalid",
  ]) {
    const auth = details(failure);
    assert.equal(auth.kind, "auth", failure);
    assert.match(auth.hint, /reconnect/i, failure);
  }

  const mixedQuota = details(
    "Cora Pi backend error: HTTP 429 Too Many Requests; service unavailable",
  );
  assert.equal(mixedQuota.kind, "quota");

  const claude529 = details(
    'Claude Code backend error: API Error 529 {"type":"overloaded_error","request_id":"req_secret"}',
  );
  assert.equal(claude529.kind, "capacity");
  assert.doesNotMatch(`${claude529.detail} ${claude529.hint}`, /req_secret|request_id/);

  const parkedRun = {
    managerTurnRecovery: {
      failedSparkCallId: "call-final",
    },
    sparkCalls: [
      {
        id: "call-retry-1",
        status: "failed",
        mode: "chat",
        conversationEpoch: 4,
        inputMessageIds: ["message-current"],
      },
      {
        id: "call-final",
        status: "failed",
        mode: "chat",
        conversationEpoch: 4,
        inputMessageIds: ["message-current"],
      },
      {
        id: "call-unrelated",
        status: "failed",
        mode: "chat",
        conversationEpoch: 4,
        inputMessageIds: ["message-older"],
      },
    ],
  };
  const failedTool = (sparkCallId) => ({
    kind: "tool",
    activity: "manager",
    status: "failed",
    sparkCallId,
    id: `spark-call:${sparkCallId}`,
  });
  assert.equal(
    isRedundantParkedBackendFailure(failedTool("call-retry-1"), parkedRun),
    true,
    "quiet retries in the same exact input lineage collapse behind the final failed call",
  );
  assert.equal(
    isRedundantParkedBackendFailure(failedTool("call-final"), parkedRun),
    false,
    "the exact failed call named by recovery remains visible",
  );
  assert.equal(
    isRedundantParkedBackendFailure(failedTool("call-unrelated"), parkedRun),
    false,
    "an older failed turn with different input remains part of history",
  );

  for (const failure of [
    "Codex backend error: Our servers are currently overloaded. Please try again later.",
    "Claude Code backend error: service unavailable",
  ]) {
    const directCapacity = details(failure);
    assert.equal(directCapacity.kind, "capacity", failure);
    assert.doesNotMatch(directCapacity.hint, /account picker|usage limit/, failure);
  }

  const conversationSource = fs.readFileSync(SOURCE_PATH, "utf8");
  const panelSource = fs.readFileSync(
    path.join(ROOT, "src", "renderer", "src", "components", "chat", "ChatPanel.tsx"),
    "utf8",
  );
  const composerSource = fs.readFileSync(
    path.join(ROOT, "src", "renderer", "src", "components", "chat", "ChatComposer.tsx"),
    "utf8",
  );
  assert.match(conversationSource, /backendFailure\.kind === "quota"/);
  assert.match(conversationSource, /isRedundantParkedBackendFailure/);
  assert.match(conversationSource, /recovery\.failedSparkCallId/);
  assert.match(conversationSource, /itemInputs\.every/);
  // The per-chat account action is gone: no choose-account affordance and no
  // picker-request plumbing may reappear in the failure surface.
  assert.doesNotMatch(conversationSource, /data-action="choose-account"/);
  assert.doesNotMatch(panelSource, /onChooseQuotaAccount|accountPickerRequest/);
  const remoteSource = fs.readFileSync(REMOTE_ACCESS_PATH, "utf8");
  assert.match(remoteSource, /const lastMessage = projectedMessages\.at\(-1\)\?\.message/);
  assert.match(remoteSource, /sourceMessages = remoteCoraSourceMessages\(run\)/);
  for (const source of [panelSource, composerSource, conversationSource]) {
    assert.doesNotMatch(
      source,
      /CustomEvent\(["'](?:spark:)?(?:choose|open)[-_ ]account/i,
      "account action must use the typed prop chain, not a window event",
    );
  }

  console.log("All chat backend failure hint checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
