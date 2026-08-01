#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function main() {
  const ipc = source("src/main/ipc.ts");
  assert.match(
    ipc,
    /"github:startPullRequest"[\s\S]{0,500}startGitHubPullRequestWorkspace\(input\)/,
    "main must expose the PR transaction through trusted IPC",
  );

  const preload = source("src/preload/index.ts");
  assert.match(
    preload,
    /startPullRequest:[\s\S]{0,220}ipcRenderer\.invoke\("github:startPullRequest", input\)/,
    "preload must expose only the typed PR transaction",
  );

  const app = source("src/renderer/src/App.tsx");
  assert.match(
    app,
    /const EXACT_GIT_OBJECT_ID = \/\^\(\?:\[a-f0-9\]\{40\}\|\[a-f0-9\]\{64\}\)\$\/i;/,
    "renderer must fail closed unless the queue supplies an exact Git OID",
  );
  assert.match(
    app,
    /window\.spark\.github\.startPullRequest\(\{\s*sourceWorkspaceId: item\.sourceWorkspaceId,\s*repositoryUrl: item\.repositoryUrl,\s*pullRequestNumber: item\.pullRequest\.number,\s*expectedHeadCommitOid,\s*\}\)/,
    "renderer must send only the pinned PR transaction fields",
  );
  assert.match(
    app,
    /handleActivateWorkspace\(result\.workspaceId\);\s*handleRunSnapshot\(run, \{ select: true, focusRuns: true \}\);/,
    "the imported workspace must become active before its run is selected",
  );
  assert.match(
    app,
    /item\.kind === "pull-request" &&\s*!link &&\s*EXACT_GIT_OBJECT_ID\.test\([\s\S]{0,160}\)\s*\) \{\s*await handleStartGitHubPullRequest\(item\);/,
    "only an unlinked PR with a pinned head may start from the queue",
  );

  const queue = source(
    "src/renderer/src/components/git/GitHubWorkQueue.tsx",
  );
  assert.match(queue, /const \[loadError, setLoadError\]/);
  assert.match(queue, /const \[actionError, setActionError\]/);
  assert.doesNotMatch(
    queue,
    /const load = useCallback[\s\S]{0,350}setActionError\(null\)/,
    "background refresh must not erase an import failure",
  );
  assert.match(queue, /<QueueMessage tone="error" alert>/);
  assert.match(queue, /aria-busy=\{busyKey === item\.key\}/);
  assert.match(queue, /return "Import PR";/);
  assert.ok(queue.includes('"Open pinned run"'));
  assert.ok(queue.includes('"Open pinned worktree"'));

  // The queue reaches github.com, so it must never poll on a bare timer: the
  // only automatic reads happen while the section is on screen in a visible
  // window, and they stop the moment it is hidden, collapsed or unmounted.
  assert.doesNotMatch(
    queue,
    /30_000|30000/,
    "the queue must not keep the old always-on 30s poll",
  );
  assert.match(
    queue,
    /const QUEUE_VISIBLE_REFRESH_MS = 60_000;/,
    "the visible-only auto refresh must be a modest 60s",
  );
  assert.match(
    queue,
    /new IntersectionObserver\(/,
    "auto refresh must be gated on the section actually being on screen",
  );
  assert.match(
    queue,
    /const shown = \(\): boolean =>\s*onScreen && document\.visibilityState === "visible";/,
    "auto refresh must require both an on-screen section and a visible window",
  );
  assert.match(
    queue,
    /timer = window\.setInterval\(\(\) => \{\s*if \(shown\(\)\) void load\(true\);\s*else stop\(\);\s*\}, QUEUE_VISIBLE_REFRESH_MS\);/,
    "the interval must stop itself as soon as the surface is hidden",
  );
  assert.doesNotMatch(
    queue,
    /addEventListener\("focus"/,
    "window focus must not trigger a background GitHub read",
  );
  assert.match(
    queue,
    /void load\(refreshKey > 0\)/,
    "a bumped refresh key must force a fresh read",
  );
  const unified = source(
    "src/renderer/src/components/git/GitHubSection.tsx",
  );
  assert.match(
    unified,
    /title="Refresh GitHub"[\s\S]{0,80}onClick=\{onRefresh\}/,
    "the unified GitHub block must keep one explicit refresh control",
  );

  console.log(
    "PASS desktop pinned-PR IPC, queue action, navigation, error retention, and stale-revision labels",
  );
}

main();
