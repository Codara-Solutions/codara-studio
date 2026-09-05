#!/usr/bin/env node
"use strict";

// MCP servers are shared across every Claude account.
//
// They live in `.claude.json`, which stays per account because it also carries
// `oauthAccount`, so a managed account used to start with an empty MCP list
// while the personal login had the real one. This suite drives the real merge
// over real files and pins the contract:
//
//   - the personal list reaches accounts that have no config file yet,
//   - a server added on ANY account reaches the others,
//   - a deletion propagates instead of being resurrected from a sibling,
//   - an edit outranks a deletion, and the newest writer wins a conflict,
//   - identity and every other key survive untouched,
//   - unreadable files are skipped, never rewritten or emptied,
//   - files are owner-only and the pass is idempotent.
//
//   node scripts/test-claude-cli-mcp-sync.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-mcp-sync-"));

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function load() {
  const outfile = path.join(TMP, "mcp-sync.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "claude-cli-mcp-sync.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    external: ["electron"],
    logLevel: "silent",
  });
  return require(outfile);
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const servers = (file) => read(file).mcpServers ?? {};
const mode = (file) => fs.statSync(file).mode & 0o777;
// Distinct mtimes: the merge breaks conflicts by "most recently written".
const touch = (file, ageMs) => {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
};

async function main() {
  const mod = await load();

  const caseDir = (name) => {
    const dir = path.join(TMP, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  // A fresh install: the personal login has servers, one managed account has a
  // config file without them, another has never been launched at all.
  {
    const dir = caseDir("seed");
    const personal = path.join(dir, ".claude.json");
    const managed = path.join(dir, "a", ".claude.json");
    const virgin = path.join(dir, "b", ".claude.json");
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.mkdirSync(path.dirname(virgin), { recursive: true });
    fs.writeFileSync(
      personal,
      JSON.stringify({
        oauthAccount: { accountUuid: "personal-uuid", emailAddress: "me@example.com" },
        hasCompletedOnboarding: true,
        projects: { "/repo": { allowedTools: [] } },
        mcpServers: { hetzner: { command: "mcp-hetzner-go" }, runpod: { command: "runpod" } },
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      managed,
      JSON.stringify({ oauthAccount: { accountUuid: "managed-uuid" }, hasCompletedOnboarding: true }),
      { mode: 0o600 },
    );

    const result = await mod.syncClaudeCliMcpServers({
      baselinePath: path.join(dir, "mcp-servers.json"),
      files: [
        { path: personal, create: false },
        { path: managed, create: true },
        { path: virgin, create: true },
      ],
    });

    assert.deepEqual(result.names, ["hetzner", "runpod"]);
    assert.deepEqual(Object.keys(servers(managed)).sort(), ["hetzner", "runpod"]);
    assert.deepEqual(Object.keys(servers(virgin)).sort(), ["hetzner", "runpod"]);
    assert.deepEqual(servers(managed).hetzner, { command: "mcp-hetzner-go" });
    // Identity and everything else the file carried are untouched.
    assert.deepEqual(read(managed).oauthAccount, { accountUuid: "managed-uuid" });
    assert.equal(read(managed).hasCompletedOnboarding, true);
    assert.deepEqual(read(personal).oauthAccount, {
      accountUuid: "personal-uuid",
      emailAddress: "me@example.com",
    });
    assert.deepEqual(read(personal).projects, { "/repo": { allowedTools: [] } });
    // A managed account's first file must not inherit anyone's identity.
    assert.equal(read(virgin).oauthAccount, undefined);
    assert.equal(mode(virgin), 0o600);
    assert.equal(mode(managed), 0o600);
    // The personal file already matched the merge, so it was not rewritten.
    assert.equal(result.written.includes(personal), false);

    const again = await mod.syncClaudeCliMcpServers({
      baselinePath: path.join(dir, "mcp-servers.json"),
      files: [
        { path: personal, create: false },
        { path: managed, create: true },
        { path: virgin, create: true },
      ],
    });
    assert.deepEqual(again.written, [], "a settled set rewrites nothing");
    assert.equal(again.changed, false);
    pass("the personal MCP list reaches every account, identity untouched, and settles");
  }

  // Additions travel in both directions; deletions propagate; edits win.
  {
    const dir = caseDir("merge");
    const baselinePath = path.join(dir, "mcp-servers.json");
    const personal = path.join(dir, ".claude.json");
    const managed = path.join(dir, "a", ".claude.json");
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    const files = [
      { path: personal, create: false },
      { path: managed, create: true },
    ];
    fs.writeFileSync(
      personal,
      JSON.stringify({ mcpServers: { shared: { command: "one" } } }),
      { mode: 0o600 },
    );
    fs.writeFileSync(managed, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(Object.keys(servers(managed)), ["shared"]);

    // Added on the MANAGED side: it must reach the personal login too.
    fs.writeFileSync(
      managed,
      JSON.stringify({ mcpServers: { shared: { command: "one" }, added: { command: "new" } } }),
      { mode: 0o600 },
    );
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(Object.keys(servers(personal)).sort(), ["added", "shared"]);
    assert.deepEqual(servers(personal).added, { command: "new" });

    // Deleted on the personal side: the sibling copy must not resurrect it.
    fs.writeFileSync(
      personal,
      JSON.stringify({ mcpServers: { shared: { command: "one" } } }),
      { mode: 0o600 },
    );
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(Object.keys(servers(managed)), ["shared"], "the deletion propagated");
    assert.deepEqual(Object.keys(servers(personal)), ["shared"]);

    // Edited on one side while deleted on the other: the edit survives.
    fs.writeFileSync(
      personal,
      JSON.stringify({ mcpServers: { shared: { command: "edited" } } }),
      { mode: 0o600 },
    );
    fs.writeFileSync(managed, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(servers(managed).shared, { command: "edited" });
    assert.deepEqual(servers(personal).shared, { command: "edited" });
    pass("additions travel both ways, deletions propagate, an edit outranks a deletion");
  }

  {
    const dir = caseDir("new-account");
    const baselinePath = path.join(dir, "mcp-servers.json");
    const personal = path.join(dir, ".claude.json");
    const managed = path.join(dir, "managed.json");
    fs.writeFileSync(personal, JSON.stringify({ mcpServers: { keep: { command: "server" } } }));
    const files = [{ path: personal, create: false }];
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    fs.writeFileSync(managed, JSON.stringify({ oauthAccount: { accountUuid: "new-account" } }));
    files.push({ path: managed, create: true });
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(servers(personal), { keep: { command: "server" } },
      "a newly connected account with identity but no MCP list cannot delete everyone's servers");
    assert.deepEqual(servers(managed), servers(personal));
    fs.writeFileSync(managed, JSON.stringify({ oauthAccount: { accountUuid: "new-account" } }));
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(servers(personal), {}, "deletion propagates once the account actually received the list");
    pass("newly connected accounts receive the existing MCP list before they can delete from it");
  }

  {
    const dir = caseDir("legacy-baseline");
    const baselinePath = path.join(dir, "mcp-servers.json");
    const personal = path.join(dir, ".claude.json");
    const managed = path.join(dir, "managed.json");
    const keep = { keep: { command: "server" } };
    fs.writeFileSync(baselinePath, JSON.stringify({ mcpServers: keep }), { mode: 0o600 });
    fs.writeFileSync(personal, JSON.stringify({ mcpServers: keep }));
    fs.writeFileSync(managed, JSON.stringify({ oauthAccount: { accountUuid: "new-account" } }));
    const files = [{ path: personal, create: false }, { path: managed, create: true }];
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(servers(personal), keep);
    assert.deepEqual(servers(managed), keep);
    assert.deepEqual(read(baselinePath).participants[managed], keep);
    pass("a legacy baseline without participant history seeds safely");
  }

  if (process.platform !== "win32") {
    const dir = caseDir("failed-participant");
    const baselinePath = path.join(dir, "mcp-servers.json");
    const personal = path.join(dir, ".claude.json");
    const managed = path.join(dir, "managed.json");
    const target = path.join(dir, "elsewhere.json");
    const keep = { keep: { command: "server" } };
    fs.writeFileSync(personal, JSON.stringify({ mcpServers: keep }));
    fs.writeFileSync(target, "{}");
    fs.symlinkSync(target, managed);
    const files = [{ path: personal, create: false }, { path: managed, create: true }];
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.equal(read(baselinePath).participants[managed], undefined, "a failed write is not recorded as received");
    fs.unlinkSync(managed);
    fs.writeFileSync(managed, "{}");
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(servers(personal), keep);
    assert.deepEqual(servers(managed), keep);
    pass("a failed sync cannot turn into a deletion on the next pass");
  }

  // Two different edits to one server: the most recently written file wins.
  {
    const dir = caseDir("conflict");
    const baselinePath = path.join(dir, "mcp-servers.json");
    const personal = path.join(dir, ".claude.json");
    const managed = path.join(dir, "a", ".claude.json");
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    const files = [
      { path: personal, create: false },
      { path: managed, create: true },
    ];
    fs.writeFileSync(personal, JSON.stringify({ mcpServers: { s: { v: 0 } } }), { mode: 0o600 });
    fs.writeFileSync(managed, JSON.stringify({ mcpServers: { s: { v: 0 } } }), { mode: 0o600 });
    await mod.syncClaudeCliMcpServers({ baselinePath, files });

    fs.writeFileSync(personal, JSON.stringify({ mcpServers: { s: { v: 1 } } }), { mode: 0o600 });
    fs.writeFileSync(managed, JSON.stringify({ mcpServers: { s: { v: 2 } } }), { mode: 0o600 });
    touch(personal, 60_000);
    touch(managed, 1_000);
    await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(servers(personal).s, { v: 2 }, "the newest writer wins");
    assert.deepEqual(servers(managed).s, { v: 2 });
    pass("a conflicting edit is resolved by the most recently written file");
  }

  // An unreadable participant is skipped: never rewritten, never a deletion.
  {
    const dir = caseDir("unreadable");
    const baselinePath = path.join(dir, "mcp-servers.json");
    const personal = path.join(dir, ".claude.json");
    const broken = path.join(dir, "a", ".claude.json");
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    const files = [
      { path: personal, create: false },
      { path: broken, create: true },
    ];
    fs.writeFileSync(personal, JSON.stringify({ mcpServers: { keep: { command: "k" } } }), {
      mode: 0o600,
    });
    fs.writeFileSync(broken, "{ this is not json", { mode: 0o600 });
    const result = await mod.syncClaudeCliMcpServers({ baselinePath, files });
    assert.deepEqual(result.names, ["keep"]);
    assert.equal(fs.readFileSync(broken, "utf8"), "{ this is not json", "a broken file is left alone");
    assert.deepEqual(Object.keys(servers(personal)), ["keep"], "and never empties a healthy one");
    pass("an unreadable config is skipped rather than rewritten or treated as a deletion");
  }

  // The merge itself, without touching a disk: a file that does not exist yet
  // is not a vote to delete, or a brand-new account would wipe everyone.
  {
    const merged = mod.mergeMcpServers(
      { a: { v: 1 } },
      [
        { servers: { a: { v: 1 } }, mtimeMs: 10, exists: true },
        { servers: {}, mtimeMs: 20, exists: false },
      ],
    );
    assert.deepEqual(merged, { a: { v: 1 } });
    pass("an account with no config file yet never votes a server away");
  }

  console.log(`\nPASS Claude MCP server sharing (${passes} groups)`);
}

main()
  .then(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  });
