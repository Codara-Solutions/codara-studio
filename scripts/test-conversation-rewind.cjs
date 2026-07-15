// Focused executable coverage for the durable conversation-rewind transaction.
// A process restart after the epoch barrier must resume the same old->new epoch
// without incrementing it again or allowing the target to change.
//
//   node scripts/test-conversation-rewind.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(
  ROOT,
  "src",
  "main",
  "orchestration",
  "conversation-rewind.ts",
);
const SHARED_DIR = path.join(ROOT, "src", "shared");

async function loadContract() {
  const out = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(
              SHARED_DIR,
              `${args.path.slice("@shared/".length)}.ts`,
            ),
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

async function main() {
  const { resolveConversationRewindTransaction } = await loadContract();
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  const request = {
    messagePointer: 2,
    messageId: "message-3",
    checkpointId: "checkpoint-3",
    checkpointIndex: 2,
    scope: "chat+code",
  };

  test("fresh rewind advances the epoch once", () => {
    assert.deepEqual(
      resolveConversationRewindTransaction({
        conversationEpoch: 4,
        messageCount: 6,
        request,
      }),
      {
        oldEpoch: 4,
        newEpoch: 5,
        pointer: 2,
        checkpointIndex: 2,
        resuming: false,
      },
    );
  });

  const pending = {
    oldEpoch: 4,
    newEpoch: 5,
    messagePointer: 2,
    messageId: "message-3",
    checkpointId: "checkpoint-3",
    checkpointIndex: 2,
    scope: "chat+code",
    startedAt: "2026-07-13T00:00:00.000Z",
  };

  test("restart resumes the durable epoch instead of advancing to six", () => {
    assert.deepEqual(
      resolveConversationRewindTransaction({
        conversationEpoch: 5,
        messageCount: 6,
        pending,
        request,
      }),
      {
        oldEpoch: 4,
        newEpoch: 5,
        pointer: 2,
        checkpointIndex: 2,
        resuming: true,
      },
    );
  });

  test("restart cannot redirect the pending rewind", () => {
    assert.throws(
      () =>
        resolveConversationRewindTransaction({
          conversationEpoch: 5,
          messageCount: 6,
          pending,
          request: { ...request, messagePointer: 1 },
        }),
      /different conversation rewind is already pending/i,
    );
  });

  test("restart rejects a mismatched persisted epoch", () => {
    assert.throws(
      () =>
        resolveConversationRewindTransaction({
          conversationEpoch: 6,
          messageCount: 6,
          pending,
          request,
        }),
      /epoch mismatch/i,
    );
  });

  test("restart rejects a transcript already shorter than the durable pointer", () => {
    assert.throws(
      () =>
        resolveConversationRewindTransaction({
          conversationEpoch: 5,
          messageCount: 1,
          pending,
          request,
        }),
      /outside the retained transcript/i,
    );
  });

  console.log(`${passed} conversation-rewind contract tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
