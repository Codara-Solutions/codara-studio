#!/usr/bin/env node
"use strict";

// Re-attaching to a live pane whose caller recorded another account.
//
// A pane failed with "pty session 'pane-...' is already pinned to another
// native Claude account" and stayed dead while its shell kept running. Since
// Accounts v2, resolveFrozenNativeClaudeProfile ignores the id it is given
// and returns the Active account, so a restore that asked for account A
// starts on B, and agentSession:capture records whatever is Active when it
// runs. The renderer's pointer then names one account while the live pty is
// pinned to another (or to none, for a plain shell), and the next remount,
// renderer reload or mirror attach carried the stale id into pty:spawn.
//
// The contract checked here: an attach to a live session always succeeds,
// reports the session's own accounts, starts nothing and moves no lease. A
// process on another account only comes from killing the old one first.
//
//   node scripts/test-pty-account-reattach.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const {
  createController,
  stubPlugin,
  localOptions,
  MODULE_TS,
  CACHE_ROOT,
} = require("./test-pty-spawn-serialization.cjs");

const CLAUDE_A = "10000000-0000-4000-8000-00000000000a";
const CLAUDE_B = "10000000-0000-4000-8000-00000000000b";
const CODEX_A = "00000000-0000-4000-8000-00000000000a";
const CODEX_B = "00000000-0000-4000-8000-00000000000b";
const GROK_A = "20000000-0000-4000-8000-00000000000a";
const GROK_B = "20000000-0000-4000-8000-00000000000b";

const claudePane = (id, nativeClaudeProfileId, startupCommand = "claude --resume 11111111-1111-4111-8111-111111111111") => ({
  ...localOptions(id),
  startupCommand,
  nativeClaudeProfileId,
});

async function main() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-account-reattach-"));
  const outfile = path.join(tmp, "pty-manager.bundle.cjs");
  try {
    await esbuild.build({
      entryPoints: [MODULE_TS],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      plugins: [stubPlugin()],
      logLevel: "silent",
    });
    const controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    const pty = require(outfile);

    // Accounts v2: every Claude launch resolves to the Active account, even
    // a frozen restore that names another one.
    const resolveClaude = controller.resolveClaudeProfile;
    controller.resolveClaudeProfile = () => resolveClaude(undefined);
    controller.currentDefaultClaudeProfileId = CLAUDE_B;

    // 1. A restore that asked for A starts on B and says so.
    const restored = await pty.spawn(claudePane("pane-restored", CLAUDE_A));
    assert.equal(restored.nativeClaudeProfileId, CLAUDE_B);
    assert.equal(controller.activeProfileLeases.get("terminal:pane-restored"), CLAUDE_B);
    const spawnsAfterRestore = controller.localSpawnCalls.length;

    // The renderer's pointer still names A: the remount re-attaches.
    const reattached = await pty.spawn(claudePane("pane-restored", CLAUDE_A));
    assert.equal(reattached.attached, true, "a stale account on the pointer must not fail the pane");
    assert.equal(reattached.pid, restored.pid);
    assert.equal(reattached.nativeClaudeProfileId, CLAUDE_B, "the attach reports the live account");
    assert.equal(reattached.startupCommandHandled, false, "an attach runs no startup command");
    assert.equal(controller.localSpawnCalls.length, spawnsAfterRestore, "an attach starts no process");
    assert.equal(
      controller.activeProfileLeases.get("terminal:pane-restored"),
      CLAUDE_B,
      "the lease stays with the account the process runs on",
    );
    console.log("PASS a Claude pane restored onto the Active account re-attaches with its old pointer");

    // 2. A plain shell holds no account; `claude` typed in it was captured
    // with the Active account, and the pointer carries it into the remount.
    const plain = await pty.spawn(localOptions("pane-plain"));
    assert.equal(plain.nativeClaudeProfileId, undefined);
    const plainAttach = await pty.spawn({ ...localOptions("pane-plain"), nativeClaudeProfileId: CLAUDE_B });
    assert.equal(plainAttach.attached, true);
    assert.equal(plainAttach.pid, plain.pid);
    assert.equal(plainAttach.nativeClaudeProfileId, undefined);
    assert.equal(
      controller.activeProfileLeases.has("terminal:pane-plain"),
      false,
      "an attach never takes a lease for a shell that had none",
    );
    console.log("PASS a plain shell re-attaches when its captured pointer names an account");

    // 3. Codex keeps a managed account per pane. A pointer for another one
    // (a deleted profile restored on the default) attaches to the live pane.
    controller.currentDefaultProfileId = CODEX_A;
    const codex = await pty.spawn({ ...localOptions("pane-codex"), startupCommand: "codex --yolo" });
    assert.equal(codex.nativeCodexProfileId, CODEX_A);
    const codexAttach = await pty.spawn({
      ...localOptions("pane-codex"),
      startupCommand: "codex resume 33333333-3333-4333-8333-333333333333 --yolo",
      nativeCodexProfileId: CODEX_B,
    });
    assert.equal(codexAttach.attached, true);
    assert.equal(codexAttach.nativeCodexProfileId, CODEX_A);
    assert.equal(controller.activeProfileLeases.get("terminal:pane-codex"), CODEX_A);
    console.log("PASS a Codex pane re-attaches and reports its own account");

    // 4. Grok, same contract.
    controller.currentDefaultGrokProfileId = GROK_A;
    const grok = await pty.spawn({ ...localOptions("pane-grok"), startupCommand: "grok --yolo" });
    assert.equal(grok.nativeGrokProfileId, GROK_A);
    const grokAttach = await pty.spawn({ ...localOptions("pane-grok"), nativeGrokProfileId: GROK_B });
    assert.equal(grokAttach.attached, true);
    assert.equal(grokAttach.nativeGrokProfileId, GROK_A);
    assert.equal(controller.activeProfileLeases.get("terminal:pane-grok"), GROK_A);
    console.log("PASS a Grok pane re-attaches and reports its own account");

    // 5. A read-only mirror is an attach too.
    const mirror = await pty.spawn({
      ...localOptions("pane-restored"),
      mirror: true,
      nativeClaudeProfileId: CLAUDE_A,
      nativeCodexProfileId: CODEX_B,
      nativeGrokProfileId: GROK_B,
    });
    assert.equal(mirror.attached, true);
    assert.equal(mirror.nativeClaudeProfileId, CLAUDE_B);
    assert.equal(mirror.nativeCodexProfileId, undefined);
    assert.equal(mirror.nativeGrokProfileId, undefined);
    await assert.rejects(
      () => pty.spawn({ ...localOptions("pane-missing"), mirror: true, nativeClaudeProfileId: CLAUDE_A }),
      /mirror attach: no pty session/,
      "a mirror still never creates a session",
    );
    console.log("PASS a mirror attach reports the live accounts");

    // 6. A process on another account needs the old one gone first; the new
    // pty then holds the new account's lease and nothing else.
    pty.killImmediate("pane-codex");
    assert.equal(controller.activeProfileLeases.has("terminal:pane-codex"), false);
    const codexRespawn = await pty.spawn({
      ...localOptions("pane-codex"),
      startupCommand: "codex --yolo",
      nativeCodexProfileId: CODEX_B,
    });
    assert.equal(codexRespawn.attached, undefined);
    assert.notEqual(codexRespawn.pid, codex.pid);
    assert.equal(codexRespawn.nativeCodexProfileId, CODEX_B);
    assert.equal(controller.activeProfileLeases.get("terminal:pane-codex"), CODEX_B);
    console.log("PASS a fresh process on another account comes from a kill and respawn");

    pty.disposeAll();

    // agentSession:capture names the account of the pane's live process,
    // not the one on the renderer's pointer: Claude resolution returns the
    // Active account for any id, so the pointer would drift on every switch.
    const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "main", "ipc.ts"), "utf8");
    const capture = ipc.slice(ipc.indexOf('"agentSession:capture"'), ipc.indexOf('"agentSession:logRestore"'));
    for (const runtime of ["Codex", "Claude", "Grok"]) {
      assert.match(
        capture,
        new RegExp(`live${runtime}ProfileId \\?\\? args\\.native${runtime}ProfileId`),
        `capture prefers the live ${runtime} account`,
      );
    }
    assert.match(capture, /nativeClaudeProfileId: liveClaudeProfileId \?\? nativeClaudeExecution\?\.profileId/);
    console.log("PASS capture records the live pane's account");
  } finally {
    delete globalThis.__codaraPtySpawnHarness;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
