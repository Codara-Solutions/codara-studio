// Focused executable coverage for Cora's ask-versus-assume policy.
//
//   node scripts/test-autonomous-question-policy.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(
  ROOT,
  "src",
  "main",
  "orchestration",
  "run-question-policy.ts",
);
const SHARED_DIR = path.join(ROOT, "src", "shared");

async function loadPolicy() {
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
  const {
    decideRunManagerQuestion,
    normalizeRunQuestionSignature,
    REVERSIBLE_MANAGER_DEFAULT,
  } = await loadPolicy();
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  const options = [
    {
      id: "rewrite",
      label: "Rewrite broadly",
      description: "Replace the whole subsystem.",
      answer: "Rewrite the whole subsystem.",
    },
    {
      id: "minimal",
      label: "Smallest change",
      description: "Use existing patterns and keep the change reversible.",
      answer: "Make the smallest reversible change using existing patterns.",
    },
  ];

  test("valid hard blocker reaches the human", () => {
    assert.deepEqual(
      decideRunManagerQuestion({
        question: "Which account should Cora access?",
        category: "credentials_access",
        reason: "No repository data identifies an authorized account.",
        options: [
          {
            id: "primary",
            label: "Primary account",
            description: "Use the primary account.",
            answer: "Use the primary account.",
            recommended: true,
          },
        ],
      }),
      {
        action: "block",
        category: "credentials_access",
        reason: "No repository data identifies an authorized account.",
        recommendedOptionId: "primary",
        signature: "which account should cora access",
      },
    );
  });

  test("missing category becomes an assumption using the recommendation", () => {
    const decision = decideRunManagerQuestion({
      question: "Should the helper live beside the feature?",
      options: options.map((option) => ({
        ...option,
        recommended: option.id === "minimal",
      })),
    });
    assert.equal(decision.action, "assume");
    assert.equal(decision.optionId, "minimal");
    assert.equal(
      decision.selectedAnswer,
      "Make the smallest reversible change using existing patterns.",
    );
  });

  test("unsupported category fails closed", () => {
    const decision = decideRunManagerQuestion({
      question: "How much should change?",
      category: "implementation_preference",
      options,
    });
    assert.equal(decision.action, "protocol_error");
    assert.match(decision.error, /unsupported human-blocker category/i);
  });

  test("destructive recommendation cannot outrank a reversible option", () => {
    const decision = decideRunManagerQuestion({
      question: "How much should the local helper change?",
      options: options.map((option) => ({
        ...option,
        recommended: option.id === "rewrite",
      })),
    });
    assert.equal(decision.action, "assume");
    assert.equal(decision.optionId, "minimal");
  });

  test("destructive question without a valid category fails closed", () => {
    const decision = decideRunManagerQuestion({
      question: "Should I delete the production data?",
      options: [
        {
          id: "yes",
          label: "Delete",
          description: "Purge it permanently.",
          answer: "Delete it.",
        },
      ],
    });
    assert.equal(decision.action, "protocol_error");
    assert.match(decision.error, /missing a valid human-blocker category/i);
  });

  test("optionless tactical question gets the repository-convention default", () => {
    const decision = decideRunManagerQuestion({
      question: "What should I name the local helper?",
    });
    assert.equal(decision.action, "assume");
    assert.equal(decision.selectedAnswer, REVERSIBLE_MANAGER_DEFAULT);
  });

  test("repeated tactical question fails the manager protocol", () => {
    const question = "Should we use the existing folder?";
    const decision = decideRunManagerQuestion({
      question,
      priorAssumptions: [
        {
          id: "assumption-1",
          question,
          selectedAnswer: "Use the existing folder.",
          source: "manager_decision",
          signature: normalizeRunQuestionSignature(question),
          createdAt: "2026-07-14T00:00:00.000Z",
        },
      ],
    });
    assert.equal(decision.action, "protocol_error");
    assert.match(decision.error, /repeated a tactical question/i);
  });

  test("hard blocker without rationale fails instead of guessing", () => {
    const decision = decideRunManagerQuestion({
      question: "May I permanently delete the production data?",
      category: "destructive_irreversible",
    });
    assert.equal(decision.action, "protocol_error");
    assert.match(decision.error, /missing the required rationale/i);
  });

  test("hard blocker options require an explicit recommendation", () => {
    const decision = decideRunManagerQuestion({
      question: "Which authorized account should Cora use?",
      category: "credentials_access",
      reason: "The repository cannot identify the authorized account.",
      options: [
        {
          id: "one",
          label: "Account one",
          description: "Use account one.",
          answer: "Use account one.",
        },
        {
          id: "two",
          label: "Account two",
          description: "Use account two.",
          answer: "Use account two.",
        },
      ],
    });
    assert.equal(decision.action, "protocol_error");
    assert.match(decision.error, /without a usable recommendation/i);
  });

  console.log(`${passed} autonomous-question policy tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
