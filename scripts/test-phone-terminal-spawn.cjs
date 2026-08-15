#!/usr/bin/env node
"use strict";

// Focused coverage for the phone → Studio terminal spawn seam: the renderer
// half of terminal.create (terminalRpc + terminalRegistry). A phone's create
// rides main's terminal-bridge into this code, so the two historical failure
// modes both lived here:
//
//   1. The create landed while App had no adapter registered (boot, window
//      reload, dev HMR remount) and failed instantly with "renderer not
//      mounted" even though the gap closes by itself moments later.
//   2. Main resolved and pinned a native Claude account for the pane, but the
//      bridge dispatcher dropped `nativeClaudeProfileId`, so the spawn
//      re-resolved whatever account was Active at spawn time.
//
//   node scripts/test-phone-terminal-spawn.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) {
      console.log(`     got: ${JSON.stringify(detail)}`);
    }
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

// Bundle terminalRpc and terminalRegistry together through one entry so the
// test drives the same module instance the dispatcher closes over.
async function loadRendererSpawnSeam() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codara-phone-terminal-spawn-"),
  );
  const entry = path.join(temporaryRoot, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(
        path.join(ROOT, "src", "renderer", "src", "components", "Terminal", "terminalRegistry.ts"),
      )};`,
      `export { registerTerminalRpcHandler } from ${JSON.stringify(
        path.join(ROOT, "src", "renderer", "src", "components", "Terminal", "terminalRpc.ts"),
      )};`,
    ].join("\n"),
  );
  const outfile = path.join(temporaryRoot, "spawn-seam.cjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.web.json"),
  });
  return require(outfile);
}

async function main() {
  const seam = await loadRendererSpawnSeam();

  // ── createAgentTerminal waits for a late adapter instead of failing ──────
  {
    seam.setCreateAgentTerminalFn(null);
    const received = [];
    const pending = seam.createAgentTerminal(
      { cwd: "/tmp/ws", command: "claude --dangerously-skip-permissions" },
      2_000,
    );
    let settledEarly = false;
    pending.then(
      () => {
        settledEarly = true;
      },
      () => {
        settledEarly = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    check(
      "a create that lands before App registers its adapter stays pending",
      settledEarly === false,
    );
    seam.setCreateAgentTerminalFn((input) => {
      received.push(input);
      return { tabId: "tab-1", paneId: "pane-1", cwd: input.cwd ?? "" };
    });
    const result = await pending;
    check(
      "the waiting create resolves through the adapter registered later",
      result.tabId === "tab-1" &&
        result.paneId === "pane-1" &&
        received.length === 1 &&
        received[0].command === "claude --dangerously-skip-permissions",
      { result, received },
    );
  }

  // ── a renderer that never registers still fails, boundedly ───────────────
  {
    seam.setCreateAgentTerminalFn(null);
    const startedAt = Date.now();
    let message = null;
    try {
      await seam.createAgentTerminal({ cwd: "/tmp/ws" }, 200);
    } catch (err) {
      message = err.message;
    }
    check(
      "an adapter that never appears fails with the mount error after the bounded wait",
      typeof message === "string" &&
        message.includes("renderer not mounted") &&
        Date.now() - startedAt >= 200,
      { message, waitedMs: Date.now() - startedAt },
    );
  }

  // ── the bridge dispatcher forwards the pinned Claude account ─────────────
  {
    let onRequest = null;
    const responses = [];
    global.window = {
      spark: {
        terminalBridge: {
          onRequest: (cb) => {
            onRequest = cb;
          },
          sendResponse: (response) => {
            responses.push(response);
          },
        },
      },
    };
    seam.registerTerminalRpcHandler();
    check("terminalRpc registers against the preload bridge", onRequest !== null);
    const created = [];
    seam.setCreateAgentTerminalFn((input) => {
      created.push(input);
      return { tabId: "tab-2", paneId: "pane-2", cwd: input.cwd ?? "" };
    });
    onRequest({
      reqId: "req-1",
      op: "create",
      params: {
        cwd: "/tmp/ws",
        command: "claude --dangerously-skip-permissions",
        title: "Etienne's iPhone · Claude",
        workspaceId: "ws1",
        workspaceCwd: "/tmp/ws",
        nativeClaudeProfileId: "personal",
        origin: {
          kind: "phone",
          deviceName: "Etienne's iPhone",
          initialCols: 42,
          initialRows: 24,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      "terminal.create forwards the main-pinned nativeClaudeProfileId to the pane",
      responses.length === 1 &&
        responses[0].ok === true &&
        created.length === 1 &&
        created[0].nativeClaudeProfileId === "personal" &&
        created[0].origin?.kind === "phone" &&
        created[0].origin?.deviceName === "Etienne's iPhone",
      { responses, created },
    );
    delete global.window;
  }

  // ── source guards for the seams this test cannot execute ─────────────────
  {
    const appSource = fs.readFileSync(
      path.join(ROOT, "src", "renderer", "src", "App.tsx"),
      "utf8",
    );
    check(
      "the inventory ping is optional-called so a stale preload cannot unmount App",
      appSource.includes("notifyInventoryChanged?.()"),
    );
    const productionSource = fs.readFileSync(
      path.join(ROOT, "src", "main", "remote-access", "production.ts"),
      "utf8",
    );
    check(
      "the phone's session picker and delete flow read the same Claude state dir the create validates against",
      productionSource.includes("nativeClaudeSessionOptions(input.runtime)") &&
        /listWorkerSessionsForRemote[\s\S]{0,400}nativeClaudeSessionOptions/.test(
          productionSource,
        ),
    );
  }

  if (failures > 0) {
    console.error(`${failures} phone-terminal-spawn check(s) failed.`);
    process.exit(1);
  }
  console.log("all phone-terminal-spawn checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
