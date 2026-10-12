#!/usr/bin/env node
"use strict";

// A deleted run (by the user or the retention sweep) settles its question in
// the notification center, so the bell badge never counts a question that
// can no longer be answered. Bundles the run adapter in src/main/notify with
// the event log and center store stubbed.
//
//   node scripts/test-notify-run-settle.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const root = path.resolve(__dirname, "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-run-settle-"));
  globalThis.__runSettle = { handlers: [], settled: [], recorded: [] };
  const centerNames = [
    "centerSummary", "clearCenter", "flushNotificationCenter", "listCenterEntries", "loadNotificationCenter",
    "markCenterAllRead", "markCenterRead", "markCenterViewed", "muteCenterSource", "noteCenterWorkspaces",
    "removeCenterEntries", "removeCenterEntry", "restoreCenterEntries", "setCenterRead", "unmuteCenterSource",
  ];
  const stubs = {
    "../file-log": "export const logMain = () => {};",
    "../orchestration/event-log":
      "export const subscribeToEvents = (h) => { globalThis.__runSettle.handlers.push(h); return () => {}; };",
    "../preferences-store":
      "export const getPreferenceCached = () => false; export const loadPreferences = async () => ({ notificationChannels: {} });",
    "../storage": "export const cachedState = () => ({ workspaces: [] });",
    "./attention":
      "export const isWatchingPane = () => false; export const isPaneVisible = () => false; export const isWatchingRun = () => false; export const setAttention = () => {};",
    "./deliver":
      "export const deliver = () => {}; export const activeWindow = () => null; export const registerDeliveryWindow = () => {}; export const signalTerminalAttention = () => {};",
    "./center-store":
      centerNames.map((name) => `export const ${name} = async () => {};`).join("\n") +
      "\nexport const isEventMuted = () => false;" +
      "\nexport const settleCenterSource = async (key) => { globalThis.__runSettle.settled.push(key); };" +
      "\nexport const recordToCenter = async (event) => { globalThis.__runSettle.recorded.push(event); };",
  };
  try {
    const outfile = path.join(dir, "test.cjs");
    await esbuild.build({
      stdin: { contents: 'export { startNotifications } from "./src/main/notify";', resolveDir: root },
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      alias: { "@shared": path.join(root, "src/shared") },
      plugins: [
        {
          name: "notify-fakes",
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) =>
              args.path in stubs ? { path: args.path, namespace: "notify-fakes" } : undefined,
            );
            build.onLoad({ filter: /.*/, namespace: "notify-fakes" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
          },
        },
      ],
    });
    const api = require(outfile);
    api.startNotifications();
    const T = globalThis.__runSettle;
    assert.equal(T.handlers.length, 1);
    const emit = (event) => T.handlers[0]({ id: `e${Math.random()}`, timestamp: new Date().toISOString(), workspaceId: "w1", ...event });

    emit({ type: "run.status_updated", runId: "r1", payload: { status: "blocked", previousStatus: "running", questionMessageId: "q1" } });
    assert.equal(T.recorded.at(-1).kind, "run.blocked");
    T.settled.length = 0;

    emit({ type: "run.deleted", runId: "r1", payload: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(T.settled, ["run:r1"]);
    console.log("  PASS deleting a run settles its question");

    emit({ type: "run.deleted", payload: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(T.settled, ["run:r1"]);
    console.log("  PASS an event without a run id settles nothing");
    console.log("notify-run-settle: 2 checks passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
