// Focused checks for deterministic GitHub issue branch naming. The renderer
// uses this pure helper before provisioning a persistent copy-branch worktree.
const assert = require("node:assert/strict");
const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  const outfile = path.join(
    cacheDir,
    `github-issue-workspace-test-${process.pid}.cjs`,
  );
  mkdirSync(cacheDir, { recursive: true });

  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "shared", "github.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
    });
    delete require.cache[outfile];
    const { selectGitHubIssueBranchName } = require(outfile);

    assert.equal(
      selectGitHubIssueBranchName(
        { number: 42, title: "Fix mobile reconnect after sleep" },
        [],
      ),
      "codara/issue-42-fix-mobile-reconnect-after-sleep",
    );

    assert.equal(
      selectGitHubIssueBranchName(
        { number: 42, title: "Fix mobile reconnect after sleep" },
        [
          "codara/issue-42-fix-mobile-reconnect-after-sleep",
          "origin/codara/issue-42-fix-mobile-reconnect-after-sleep-2",
        ],
      ),
      "codara/issue-42-fix-mobile-reconnect-after-sleep-3",
      "local and remote-tracking names both participate in suffix selection",
    );

    assert.equal(
      selectGitHubIssueBranchName(
        { number: 7, title: "  Résumé / iOS: assets?!  " },
        [],
      ),
      "codara/issue-7-resume-ios-assets",
      "titles are normalized to valid readable branch slugs",
    );

    assert.equal(
      selectGitHubIssueBranchName({ number: 9, title: "🚀✨" }, []),
      "codara/issue-9-work",
      "an all-symbol title receives a stable non-empty slug",
    );

    const longName = selectGitHubIssueBranchName(
      { number: 123, title: "a".repeat(200) },
      [],
    );
    assert.equal(
      longName,
      `codara/issue-123-${"a".repeat(48)}`,
      "issue slugs are bounded",
    );

    console.log("All GitHub issue workspace naming checks passed.");
  } finally {
    rmSync(outfile, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
