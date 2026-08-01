"use strict";

const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-applicability-"));
const outfile = path.join(temp, "applicability.cjs");

function window(id, remainingPercent, scope) {
  return {
    id,
    label: id,
    scope,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
  };
}

function profile(windows, extra = {}) {
  return {
    profileId: "11111111-1111-4111-8111-111111111111",
    provider: "openai-codex",
    label: "Local",
    isDefault: true,
    status: "ok",
    checkedAt: "2026-07-31T00:00:00.000Z",
    windows,
    ...extra,
  };
}

async function main() {
  try {
    await esbuild.build({
      entryPoints: [
        path.join(
          ROOT,
          "src/main/orchestration/pi-usage-applicability.ts",
        ),
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
    });
    const { evaluateUsageForWorkload } = require(outfile);

    let evaluated = evaluateUsageForWorkload(
      profile(
        [
          window("regular", 80, { kind: "general" }),
          window("review", 0, { kind: "code_review" }),
        ],
        { limitReached: true, generalLimitReached: false },
      ),
      { kind: "agent", modelId: "gpt-5.6-sol" },
    );
    assert.equal(evaluated.headroomPercent, 80);
    assert.equal(evaluated.limitReached, false);

    evaluated = evaluateUsageForWorkload(
      profile([
        window("regular", 80, { kind: "general" }),
        window("review", 0, { kind: "code_review" }),
      ]),
      { kind: "code_review" },
    );
    assert.equal(evaluated.headroomPercent, 0);
    assert.equal(evaluated.limitReached, true);

    evaluated = evaluateUsageForWorkload(
      profile([
        window("general", 70, { kind: "general" }),
        window("opus", 0, {
          kind: "model",
          modelId: "claude-opus-5",
          modelLabel: "Opus 5",
        }),
      ]),
      { kind: "agent", modelId: "claude-sonnet-5" },
    );
    assert.equal(evaluated.headroomPercent, 70);
    assert.equal(evaluated.limitReached, false);

    evaluated = evaluateUsageForWorkload(
      profile([
        window("general", 70, { kind: "general" }),
        window("opus", 0, {
          kind: "model",
          modelId: "claude-opus-5",
          modelLabel: "Opus 5",
        }),
      ]),
      { kind: "agent", modelId: "claude-opus-5" },
    );
    assert.equal(evaluated.headroomPercent, 0);
    assert.equal(evaluated.limitReached, true);

    evaluated = evaluateUsageForWorkload(
      profile([
        window("general", 60, { kind: "general" }),
        window("unmapped", 0, {
          kind: "metered_feature",
          featureId: "feature-x",
          featureLabel: "Feature X",
        }),
      ]),
      { kind: "agent", modelId: "gpt-5.6-sol" },
    );
    assert.equal(evaluated.headroomPercent, 60);
    assert.equal(evaluated.limitReached, false);
    assert.equal(evaluated.coverage, "partial");

    evaluated = evaluateUsageForWorkload(
      profile([
        window("review", 50, { kind: "code_review" }),
        window("unmapped", 0, {
          kind: "metered_feature",
          featureId: "feature-x",
          featureLabel: "Feature X",
        }),
      ]),
      { kind: "code_review" },
    );
    assert.equal(evaluated.coverage, "partial");

    console.log(
      "PASS Pi usage applicability isolates general, model, code-review, and unmapped feature windows",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
