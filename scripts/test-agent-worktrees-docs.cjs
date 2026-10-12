#!/usr/bin/env node
"use strict";

// docs/mcp-tools.md is what an agent reads to learn why
// codara_worktree_remove refused and what to do next. Every code the removal
// check can block with must appear there, so a new refusal cannot ship
// undocumented the way the two ownership refusals once did.
//
//   node scripts/test-agent-worktrees-docs.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "src", "main", "agent-worktrees.ts"), "utf8");
const docs = fs.readFileSync(path.join(ROOT, "docs", "mcp-tools.md"), "utf8");

const blockers = [...new Set([...source.matchAll(/\bblock\("(WORKTREE_[A-Z_]+)"\)/g)].map((m) => m[1]))].sort();
assert.ok(blockers.length >= 15, `found only ${blockers.length} removal blockers; did the source change shape?`);
assert.ok(blockers.includes("WORKTREE_OWNED_BY_ACTIVE_RUN"));
assert.ok(blockers.includes("WORKTREE_OWNED_BY_LIVE_AGENT"));

const missing = blockers.filter((code) => !docs.includes(`\`${code}\``));
assert.deepEqual(missing, [], "removal blockers missing from docs/mcp-tools.md");
console.log(`  PASS all ${blockers.length} removal blocker codes are documented`);
console.log("agent-worktrees-docs: 1 check passed");
