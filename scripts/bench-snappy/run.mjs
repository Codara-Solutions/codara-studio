#!/usr/bin/env node
// Snappiness benchmark. Boots the built app (npm run build first) on a private
// Xvfb display with a throwaway home, runs the flows, and appends one JSON
// line per app run to <out>/runs.jsonl, with CPU profiles in <out>/profiles.
//
//   node scripts/bench-snappy/run.mjs --rounds 5 --out /tmp/bench
//   node scripts/bench-snappy/run.mjs --apps studio,t3code --rounds 5 --out /tmp/ab
//   node scripts/bench-snappy/run.mjs --apps t3code --build-profile
//   node scripts/bench-snappy/summarize.mjs /tmp/ab
//
// With several apps, each round runs them back to back and swaps which goes
// first, so drift on the machine lands on both. Every run records the load
// and free memory before it starts, so summarize.mjs can drop busy rounds.
// The t3code adapter needs T3CODE_BENCH_DIR (see t3code/setup.sh).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { cpuOver, memorySnapshot, sleep, systemSnapshot } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { values } = parseArgs({
  options: {
    rounds: { type: "string", default: "1" },
    apps: { type: "string", default: "studio" },
    flows: { type: "string", default: "" },
    out: { type: "string" },
    "idle-seconds": { type: "string", default: "20" },
    "build-profile": { type: "boolean", default: false },
  },
});

require("../virtual-display.cjs").useVirtualDisplay();
if (!process.env.DISPLAY) throw new Error("no display: install Xvfb");

const adapters = {
  studio: async () => {
    const studio = await import("./studio.mjs");
    return { ...studio, prepare: studio.makeFixture };
  },
  t3code: () => import("./t3code.mjs"),
};

if (values["build-profile"]) {
  const t3code = await adapters.t3code();
  console.log(JSON.stringify(await t3code.buildProfile()));
  process.exit(0);
}
if (!values.out) throw new Error("--out DIR is required");

// The same order for every app, so state left by one flow (open tabs, a long
// scrollback) weighs on both the same way.
const ORDER = ["workspaceSwitch", "tabSwitch", "composerTyping", "terminalTyping", "chatOpenScroll", "explorer", "bigFile", "browserPane", "terminalBusy", "chatStream", "agents"];
const wanted = values.flows ? values.flows.split(",") : ["startup", "idle", ...ORDER];
mkdirSync(`${values.out}/profiles`, { recursive: true });

async function runApp(name, round) {
  const adapter = await adapters[name]();
  const record = { app: name, round, before: systemSnapshot(), flows: {} };
  const fixture = adapter.prepare();
  try {
    // The first launch on prepared state, then a relaunch on the same state:
    // the second is the warm start. The OS file cache is warm for both.
    let session = await adapter.launch(fixture);
    record.flows.firstStart = session.startup;
    if (wanted.includes("startup")) {
      await sleep(3000);
      await adapter.close(session);
      session = await adapter.launch(fixture);
      record.flows.warmStart = session.startup;
    }
    await sleep(5000);
    if (wanted.includes("idle")) {
      record.flows.idle = { ...(await cpuOver(session.pid, Number(values["idle-seconds"]) * 1000)), memory: memorySnapshot(session.pid) };
    }
    for (const flow of ORDER) {
      if (!wanted.includes(flow) || !adapter.flows[flow]) continue;
      const startedAt = Date.now();
      let result;
      try {
        result = await adapter.flows[flow](session, fixture);
      } catch (error) {
        result = { error: String(error?.message ?? error).split("\n")[0] };
      }
      if (result.profile) {
        writeFileSync(`${values.out}/profiles/${name}-r${round}-${flow}.cpuprofile`, JSON.stringify(result.profile));
        delete result.profile;
      }
      result.load1 = systemSnapshot().load1;
      result.wallMs = Date.now() - startedAt;
      record.flows[flow] = result;
      console.error(`[${name} r${round}] ${flow}: ${JSON.stringify(result).slice(0, 300)}`);
    }
    await adapter.close(session);
  } finally {
    adapter.disposeFixture(fixture);
  }
  record.after = systemSnapshot();
  appendFileSync(`${values.out}/runs.jsonl`, `${JSON.stringify(record)}\n`);
}

const apps = values.apps.split(",");
for (let round = 0; round < Number(values.rounds); round += 1) {
  for (const name of round % 2 === 0 ? apps : [...apps].reverse()) await runApp(name, round);
}
