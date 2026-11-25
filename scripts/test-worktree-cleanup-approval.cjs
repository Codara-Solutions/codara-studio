#!/usr/bin/env node
"use strict";

// The agent's "Remove worktrees?" dialog (WorktreeCleanupApproval.tsx) and
// the pure rules behind it in src/shared/worktree-cleanup-agent.ts:
//   - the agent's one line is cleaned, capped and shown as text, never markup
//   - rows that can go come first, safe ones leading; rows that cannot fold
//     into one line at the bottom, counted by cause
//   - nothing starts ticked; Tick all ticks only rows that can go; a blocked
//     row is never sent as remove, whatever the choices say
//   - a row that can be ticked never says keep, and each says what ticking does
// Clicks, the fold opening and the screenshot are in test-dialog-glass-surface.cjs.
//
//   node scripts/test-worktree-cleanup-approval.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents:
        'export * from "./src/shared/worktree-cleanup-agent";\n' +
        'export { default as WorktreeCleanupApproval } from "./src/renderer/src/components/worktree-cleanup/WorktreeCleanupApproval";\n' +
        'export { renderToStaticMarkup } from "react-dom/server";\nexport { createElement } from "react";',
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    loader: { ".css": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime"],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const IN_USE = "In use by an open tab or a running program";

function item(name, extra = {}) {
  return {
    repoRoot: "/work/widgets",
    repoName: "widgets",
    path: `/work/trees/widgets/${name}`,
    branch: `feat/${name}`,
    workspaceName: null,
    sizeBytes: 10_000_000,
    advice: "safe",
    reason: "Merged through pull request #12, clean and idle.",
    blocked: null,
    blockedGroup: null,
    missing: false,
    merged: true,
    branchDeletable: true,
    onRemote: true,
    pullRequest: { number: 12, state: "merged" },
    ignored: [],
    unmergedCommits: 0,
    remote: { offered: false, reason: "No merged pull request uses it.", name: "origin", suggested: false },
    ...extra,
  };
}

function blocked(name, group, text) {
  return item(name, { advice: "keep", reason: text, blocked: text, blockedGroup: group });
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function main() {
  const m = await load();

  check("the agent's line is one plain line of at most 200 characters", () => {
    assert.equal(m.agentReasonLine("  Remove the 17 merged ones,\nas you approved.  "), "Remove the 17 merged ones, as you approved.");
    assert.equal(m.agentReasonLine("a‮b​c\u0007d"), "a b c d", "direction, zero-width and control characters go");
    assert.equal(m.agentReasonLine("<b>bold</b> & <script>x</script>"), "<b>bold</b> & <script>x</script>", "markup is kept as text for React to escape");
    assert.equal(m.agentReasonLine("   "), null);
    assert.equal(m.agentReasonLine(42), null);
    const long = m.agentReasonLine("x".repeat(500));
    assert.equal(Array.from(long).length, m.AGENT_REASON_MAX);
    assert.ok(long.endsWith("…"));
    const emoji = m.agentReasonLine("😀".repeat(300));
    assert.equal(Array.from(emoji).length, m.AGENT_REASON_MAX, "a cut never splits a character");
  });

  const removable = [
    ...Array.from({ length: 3 }, (_, i) => item(`check-${i}`, { advice: "review", merged: false, unmergedCommits: 2 })),
    ...Array.from({ length: 3 }, (_, i) => item(`safe-${i}`)),
    item("draft-pr", { advice: "keep", reason: "Pull request #40 is a draft, still open.", merged: false, unmergedCommits: 4, pullRequest: { number: 40, state: "draft" } }),
  ];
  const stuck = [
    blocked("busy-a", IN_USE, "In use: the Claude Code tab “fix the build”."),
    blocked("dirty", "With unsaved changes", "It has unsaved changes. Only you can remove it, from Clean up worktrees."),
    blocked("busy-b", IN_USE, "In use: a terminal tab."),
    blocked("busy-c", IN_USE, "In use: node (pid 4242)."),
  ];
  const items = [stuck[0], ...removable.slice(0, 4), stuck[1], ...removable.slice(4), stuck[2], stuck[3]];

  check("rows that can go come first, safe ones leading; blocked rows fold, grouped and counted", () => {
    const layout = m.approvalLayout(items);
    assert.deepEqual(
      layout.removable.map((entry) => entry.path.split("/").pop()),
      ["safe-0", "safe-1", "safe-2", "check-0", "check-1", "check-2", "draft-pr"],
    );
    assert.equal(layout.blockedCount, 4);
    assert.deepEqual(
      layout.blocked.map((group) => [group.label, group.items.length]),
      [[IN_USE, 3], ["With unsaved changes", 1]],
    );
    const legacy = m.approvalLayout([{ ...stuck[0], blockedGroup: undefined }]);
    assert.equal(legacy.blocked[0].label, stuck[0].blocked, "without a group the blocked text groups");
  });

  check("nothing starts ticked, Tick all ticks only rows that can go, Untick all clears", () => {
    const initial = m.initialApprovalChoices(items);
    assert.equal(Object.keys(initial).length, items.length);
    for (const choice of Object.values(initial)) assert.deepEqual(choice, { remove: false, deleteRemoteBranch: false });
    // A forged state with a blocked row ticked: Tick all unticks it again.
    const forged = { ...initial, [m.approvalKey(stuck[0])]: { remove: true, deleteRemoteBranch: true } };
    const all = m.tickAllApprovals(items, forged);
    for (const entry of items) assert.equal(all[m.approvalKey(entry)].remove, entry.blocked === null, entry.path);
    assert.equal(all[m.approvalKey(stuck[0])].deleteRemoteBranch, false);
    for (const choice of Object.values(m.untickAllApprovals(items))) assert.deepEqual(choice, { remove: false, deleteRemoteBranch: false });
  });

  check("a blocked row is never sent as remove, nor an unoffered remote branch", () => {
    const everything = Object.fromEntries(items.map((entry) => [m.approvalKey(entry), { remove: true, deleteRemoteBranch: true }]));
    const sent = m.approvalAnswerItems(items, everything, true);
    for (const entry of sent) {
      const source = items.find((candidate) => candidate.path === entry.path);
      assert.equal(entry.remove, source.blocked === null, entry.path);
      assert.equal(entry.deleteRemoteBranch, false, "no row here offers its remote branch");
    }
    for (const entry of m.approvalAnswerItems(items, everything, false)) assert.equal(entry.remove, false, "a decline removes nothing");
    const offered = item("offered", { remote: { offered: true, reason: "Pull request #12 merged it.", name: "origin", suggested: false } });
    const [answer] = m.approvalAnswerItems([offered], { [m.approvalKey(offered)]: { remove: true, deleteRemoteBranch: true } }, true);
    assert.equal(answer.deleteRemoteBranch, true);
  });

  check("a row that can be ticked never says keep, and says what ticking does", () => {
    for (const entry of removable) assert.notEqual(m.APPROVAL_BADGE_LABELS[m.approvalBadge(entry)].toLowerCase(), "keep");
    assert.equal(m.approvalBadge(removable[6]), "check", "an open draft pull request reads Check first");
    assert.equal(m.tickEffect(item("a"), true), "Merged: folder and local branch go. The branch on GitHub stays.");
    assert.equal(m.tickEffect(item("a"), false), "Merged: folder goes, the local branch stays. The branch on GitHub stays.");
    assert.equal(m.tickEffect(item("a", { branchDeletable: false, onRemote: false }), true), "Merged: folder goes, the local branch stays.");
    assert.match(
      m.tickEffect(item("a", { remote: { offered: true, reason: "", name: "origin", suggested: false } }), true),
      /stays unless you tick it below/,
    );
    assert.equal(m.tickEffect(removable[6], true), "Folder goes. Branch and pull request #40 stay on GitHub.");
    assert.equal(
      m.tickEffect(item("a", { merged: false, unmergedCommits: 2, pullRequest: null, onRemote: true }), true),
      "Folder goes. The branch stays, here and on origin.",
    );
    assert.equal(
      m.tickEffect(item("a", { merged: false, unmergedCommits: 3, pullRequest: null, onRemote: false }), true),
      "Folder goes. The branch stays on this computer only, with its 3 commits that are not merged.",
    );
    assert.equal(
      m.tickEffect(item("a", { merged: false, unmergedCommits: 1, pullRequest: null, onRemote: null }), true),
      "Folder goes. The branch stays, with its 1 commit that is not merged.",
    );
    assert.equal(m.tickEffect(item("a", { branch: null, merged: false, unmergedCommits: 1 }), true), "Folder goes. Its 1 commit stays recoverable for 30 days.");
    assert.equal(m.tickEffect(item("a", { missing: true }), true), "The folder is already gone: only git's record of it goes.");
  });

  check("the dialog shows the agent's words escaped, the rows that can go, and folds the rest", () => {
    const request = {
      id: "r",
      agent: { client: "claude-code", workspaceName: "Widgets" },
      reason: '<img src=x onerror="alert(1)"> Remove the merged ones & keep the rest',
      expiresAt: Date.now() + 60_000,
      items,
    };
    const html = m.renderToStaticMarkup(m.createElement(m.WorktreeCleanupApproval, { request, onDone() {} }));
    assert.ok(!/<img/i.test(html), "the agent's markup is not rendered");
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Remove the merged ones &amp; keep the rest"), "the agent's words show as text");
    assert.match(html, /claude-code in Widgets says/);
    // The one checked box is the "also delete the local branch" toggle, above the list.
    assert.equal((html.match(/\bchecked=""/g) ?? []).length, 1);
    const list = html.slice(html.indexOf('aria-label="Worktrees the agent asks to remove"'));
    assert.ok(!/\bchecked=""/.test(list), "no row starts ticked");
    assert.match(html, /Tick all 7</);
    assert.match(html, /7 worktrees can be removed/);
    assert.match(html, /4 cannot be removed now/);
    assert.match(html, /3 in use by an open tab or a running program · 1 with unsaved changes/);
    assert.match(html, /aria-expanded="false"/);
    for (const entry of stuck) assert.ok(!html.includes(`data-worktree-path="${entry.path}"`), `${entry.path} is folded`);
    const order = [...html.matchAll(/data-worktree-path="([^"]+)"/g)].map((match) => match[1].split("/").pop());
    assert.deepEqual(order, ["safe-0", "safe-1", "safe-2", "check-0", "check-1", "check-2", "draft-pr"]);
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1 + 7, "one per row that can go, and the merged-branches toggle");
    assert.ok(!/>keep</.test(html), "no badge says keep");
    assert.match(html, /If ticked: <\/span>Folder goes\. Branch and pull request #40 stay on GitHub\./);
    const quiet = m.renderToStaticMarkup(m.createElement(m.WorktreeCleanupApproval, { request: { ...request, reason: null }, onDone() {} }));
    assert.ok(!quiet.includes("worktree-cleanup-agent-reason"), "no line when the agent gave none");
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
