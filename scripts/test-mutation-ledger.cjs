// Focused, Electron-free harness for DurableMutationLedger.
//
//   node scripts/test-mutation-ledger.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "remote-access", "mutation-ledger.ts");

async function expectReject(promise, ErrorType, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}, got ${error?.constructor?.name}`);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codara-mutation-ledger-"));
  const bundlePath = path.join(temporaryRoot, "mutation-ledger.bundle.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundlePath,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const {
    DurableMutationLedger,
    MutationOutcomeUnknownError,
    MutationRequestConflictError,
    canonicalMutationParams,
    mutationRequestSha256,
  } = require(bundlePath);

  try {
    // Canonical request identity is independent of object insertion order.
    assert.equal(
      canonicalMutationParams({ z: [3, { b: true, a: null }], a: "first" }),
      '{"a":"first","z":[3,{"a":null,"b":true}]}',
    );
    assert.equal(
      mutationRequestSha256("files.move", { from: "a", to: "b" }),
      mutationRequestSha256("files.move", { to: "b", from: "a" }),
    );

    const root = path.join(temporaryRoot, "primary");
    const ledger = await DurableMutationLedger.open({
      rootDir: root,
      maxCompletedEntries: 20,
      completedRetentionMs: Infinity,
    });
    assert.equal(ledger.filePath, path.join(root, "mutation-ledger.json"));

    // Namespaces make equal request IDs independent.
    let namespaceExecutions = 0;
    assert.equal(await ledger.execute({
      callerNamespace: "phone-a",
      requestId: "same-id",
      method: "counter.add",
      params: { amount: 1 },
    }, async () => ++namespaceExecutions), 1);
    assert.equal(await ledger.execute({
      callerNamespace: "phone-b",
      requestId: "same-id",
      method: "counter.add",
      params: { amount: 1 },
    }, async () => ++namespaceExecutions), 2);

    // Concurrent identical calls join one operation and one result.
    let releaseOperation;
    const operationGate = new Promise((resolve) => {
      releaseOperation = resolve;
    });
    let joinedExecutions = 0;
    const joinedRequest = {
      callerNamespace: "phone-a",
      requestId: "join-once",
      method: "files.move",
      params: { from: "one", to: "two" },
    };
    const first = ledger.execute(joinedRequest, async () => {
      joinedExecutions += 1;
      await operationGate;
      return { moved: true, nested: { count: 1 } };
    });
    const second = ledger.execute({
      ...joinedRequest,
      params: { to: "two", from: "one" },
    }, async () => {
      joinedExecutions += 1;
      return { moved: false };
    });
    await waitFor(() => joinedExecutions === 1, "the joined operation to start");
    assert.equal(joinedExecutions, 1);

    // Reusing the in-flight key for changed work is rejected immediately.
    await expectReject(ledger.execute({
      ...joinedRequest,
      params: { from: "one", to: "different" },
    }, async () => ({ moved: false })), MutationRequestConflictError, "MUTATION_REQUEST_CONFLICT");

    releaseOperation();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, { moved: true, nested: { count: 1 } });
    assert.deepEqual(secondResult, firstResult);
    assert.equal(joinedExecutions, 1);

    // Mutating one returned result cannot alter the persisted receipt.
    firstResult.nested.count = 99;
    const replayed = await ledger.execute(joinedRequest, async () => {
      joinedExecutions += 1;
      return { moved: false };
    });
    assert.deepEqual(replayed, { moved: true, nested: { count: 1 } });
    assert.equal(joinedExecutions, 1);

    // The method participates in the commitment too.
    await expectReject(ledger.execute({
      ...joinedRequest,
      method: "files.copy",
    }, async () => null), MutationRequestConflictError, "MUTATION_REQUEST_CONFLICT");

    // A completed result, including undefined, survives a fresh instance.
    let undefinedExecutions = 0;
    const undefinedRequest = {
      callerNamespace: "phone-a",
      requestId: "undefined-result",
      method: "terminal.stop",
      params: { paneId: "pane-1" },
    };
    assert.equal(await ledger.execute(undefinedRequest, async () => {
      undefinedExecutions += 1;
      return undefined;
    }), undefined);
    const reloaded = await DurableMutationLedger.open({
      rootDir: root,
      maxCompletedEntries: 20,
      completedRetentionMs: Infinity,
    });
    assert.deepEqual(await reloaded.execute(joinedRequest, async () => {
      joinedExecutions += 1;
      return null;
    }), { moved: true, nested: { count: 1 } });
    assert.equal(await reloaded.execute(undefinedRequest, async () => {
      undefinedExecutions += 1;
      return "wrong";
    }), undefined);
    assert.equal(joinedExecutions, 1);
    assert.equal(undefinedExecutions, 1);

    // Once an operation has started, an exception is conservatively unknown.
    let failingExecutions = 0;
    const failingRequest = {
      callerNamespace: "phone-a",
      requestId: "effect-threw",
      method: "git.commit",
      params: { message: "Maybe committed" },
    };
    await expectReject(reloaded.execute(failingRequest, async () => {
      failingExecutions += 1;
      throw new Error("connection dropped");
    }), MutationOutcomeUnknownError, "MUTATION_OUTCOME_UNKNOWN");
    assert.equal(reloaded.getRecord("phone-a", "effect-threw").status, "outcome_unknown");
    await expectReject(reloaded.execute(failingRequest, async () => {
      failingExecutions += 1;
      return "must not run";
    }), MutationOutcomeUnknownError, "MUTATION_OUTCOME_UNKNOWN");
    assert.equal(failingExecutions, 1);
    assert.deepEqual(
      await reloaded.executeRecoverable(failingRequest, async () => {
        failingExecutions += 1;
        return { reconciled: true };
      }),
      { reconciled: true },
    );
    assert.equal(failingExecutions, 2);
    assert.deepEqual(
      await reloaded.execute(failingRequest, async () => {
        throw new Error("completed recovery must replay its receipt");
      }),
      { reconciled: true },
    );

    // Simulate a crash after the durable pending receipt but before a result.
    let rejectStalled;
    const stalledGate = new Promise((_, reject) => {
      rejectStalled = reject;
    });
    const stalledRequest = {
      callerNamespace: "phone-crash",
      requestId: "pending-at-crash",
      method: "automation.start",
      params: { automationId: "auto-1" },
    };
    const stalled = reloaded.execute(stalledRequest, () => stalledGate);
    await waitFor(
      () => reloaded.getRecord("phone-crash", "pending-at-crash")?.status === "pending",
      "the crash-simulation pending record",
    );
    // Wait until the pending record is visibly durable, not only in memory.
    await waitFor(
      () => fs.readFileSync(reloaded.filePath, "utf8").includes("pending-at-crash"),
      "the crash-simulation receipt to reach disk",
    );
    const crashRecovery = await DurableMutationLedger.open({
      rootDir: root,
      maxCompletedEntries: 20,
      completedRetentionMs: Infinity,
    });
    const recovered = crashRecovery.getRecord("phone-crash", "pending-at-crash");
    assert.equal(recovered.status, "outcome_unknown");
    assert.equal(recovered.outcomeUnknownReason, "process_restarted_while_pending");
    await expectReject(crashRecovery.execute(stalledRequest, async () => "duplicate"), MutationOutcomeUnknownError);
    rejectStalled(new Error("simulated process death"));
    await expectReject(stalled, MutationOutcomeUnknownError);
    assert.equal(
      await crashRecovery.executeRecoverable(
        stalledRequest,
        async () => "domain-reconciled",
      ),
      "domain-reconciled",
    );
    assert.equal(
      await crashRecovery.execute(
        stalledRequest,
        async () => "must-not-run",
      ),
      "domain-reconciled",
    );

    // Count pruning removes only the oldest completed entries. Both kinds of
    // unresolved records survive even when they exceed the completed bound.
    let clock = 1_000;
    const boundedRoot = path.join(temporaryRoot, "bounded");
    const bounded = await DurableMutationLedger.open({
      rootDir: boundedRoot,
      maxCompletedEntries: 2,
      completedRetentionMs: Infinity,
      now: () => clock,
    });
    for (let index = 1; index <= 3; index += 1) {
      clock += 10;
      await bounded.execute({
        callerNamespace: "retention",
        requestId: `complete-${index}`,
        method: "test.complete",
        params: { index },
      }, async () => index);
    }
    await expectReject(bounded.execute({
      callerNamespace: "retention",
      requestId: "unknown-kept",
      method: "test.unknown",
      params: {},
    }, async () => {
      throw new Error("ambiguous");
    }), MutationOutcomeUnknownError);
    const boundedRecords = bounded.listRecords();
    assert.equal(boundedRecords.filter((record) => record.status === "completed").length, 2);
    assert.equal(bounded.getRecord("retention", "complete-1"), null);
    assert.equal(bounded.getRecord("retention", "complete-2").status, "completed");
    assert.equal(bounded.getRecord("retention", "complete-3").status, "completed");
    assert.equal(bounded.getRecord("retention", "unknown-kept").status, "outcome_unknown");

    // Age pruning also leaves unresolved records alone.
    clock += 5_000;
    const aged = await DurableMutationLedger.open({
      rootDir: boundedRoot,
      maxCompletedEntries: 2,
      completedRetentionMs: 1_000,
      now: () => clock,
    });
    assert.equal(aged.listRecords().filter((record) => record.status === "completed").length, 0);
    assert.equal(aged.getRecord("retention", "unknown-kept").status, "outcome_unknown");

    // A backwards wall-clock jump cannot prune the very receipt execute() is
    // about to acknowledge. Older completed receipts make room instead.
    let rollbackClock = 10_000;
    const rollback = await DurableMutationLedger.open({
      rootDir: path.join(temporaryRoot, "clock-rollback"),
      maxCompletedEntries: 1,
      completedRetentionMs: Infinity,
      now: () => rollbackClock,
    });
    await rollback.execute({
      callerNamespace: "clock",
      requestId: "before",
      method: "clock.test",
      params: 1,
    }, async () => "before");
    rollbackClock = 1;
    await rollback.execute({
      callerNamespace: "clock",
      requestId: "after-rollback",
      method: "clock.test",
      params: 2,
    }, async () => "after");
    assert.equal(rollback.getRecord("clock", "before"), null);
    assert.equal(rollback.getRecord("clock", "after-rollback").status, "completed");

    // Caller-supplied explicit paths and nested root-relative paths both work,
    // while an escaping path is refused.
    const explicitFile = path.join(temporaryRoot, "explicit", "receipts.json");
    const explicit = await DurableMutationLedger.open({ filePath: explicitFile });
    await explicit.execute({
      callerNamespace: "explicit",
      requestId: "one",
      method: "noop",
      params: null,
    }, async () => true);
    assert.equal(JSON.parse(await fsp.readFile(explicitFile, "utf8")).schemaVersion, 1);
    await assert.rejects(
      DurableMutationLedger.open({ rootDir: root, fileName: "../escape.json" }),
      /beneath rootDir/,
    );

    // Atomic writes leave no staging debris and the final file is valid JSON.
    const debris = (await fsp.readdir(path.dirname(explicitFile)))
      .filter((name) => name.includes(".tmp"));
    assert.deepEqual(debris, []);
    JSON.parse(await fsp.readFile(explicitFile, "utf8"));

    // Corruption fails closed rather than silently discarding receipts.
    const corruptFile = path.join(temporaryRoot, "corrupt.json");
    await fsp.writeFile(corruptFile, "{ definitely not json", "utf8");
    await assert.rejects(
      DurableMutationLedger.open({ filePath: corruptFile }),
      /not valid JSON/,
    );

    console.log("PASS mutation ledger durability, joining, conflict, recovery, and retention");
  } finally {
    await fsp.rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 10,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
