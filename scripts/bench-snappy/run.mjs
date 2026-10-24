#!/usr/bin/env node
// Snappiness benchmark for Codara Studio. Boots the built app (npm run build
// first) on a private Xvfb display with a throwaway home, runs the flows, and
// writes one JSON record per run.
//
//   node scripts/bench-snappy/run.mjs --runs 3 --flows startup,workspaceSwitch --out /tmp/bench.json
//
// Every run records the machine's load and free memory, so a comparison can
// drop runs taken while something else was busy.

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cpuOver, memorySnapshot, sleep, systemSnapshot } from "./lib.mjs";
import * as studio from "./studio.mjs";

const require = createRequire(import.meta.url);
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "1" },
    flows: { type: "string", default: "" },
    out: { type: "string" },
    "idle-seconds": { type: "string", default: "20" },
  },
});

require("../virtual-display.cjs").useVirtualDisplay();
if (!process.env.DISPLAY) throw new Error("no display: install Xvfb");

const wanted = values.flows ? values.flows.split(",") : ["startup", "idle", ...Object.keys(studio.flows)];
const results = [];
for (let run = 0; run < Number(values.runs); run += 1) {
  const record = { app: "studio", run, before: systemSnapshot(), flows: {} };
  const fixture = studio.makeFixture();
  try {
    // A first launch on a fresh home is the cold start; the second launch on
    // the same home is the warm start. The OS file cache is warm for both.
    let session = await studio.launch(fixture);
    record.flows.coldStart = session.startup;
    if (wanted.includes("startup")) {
      await sleep(3000);
      await studio.close(session);
      session = await studio.launch(fixture);
      record.flows.warmStart = session.startup;
    }
    await sleep(5000);
    if (wanted.includes("idle")) {
      record.flows.idle = { ...(await cpuOver(session.pid, Number(values["idle-seconds"]) * 1000)), memory: memorySnapshot(session.pid) };
    }
    for (const name of wanted) {
      const flow = studio.flows[name];
      if (!flow) continue;
      try {
        record.flows[name] = await flow(session, fixture);
      } catch (error) {
        record.flows[name] = { error: String(error?.message ?? error).split("\n")[0] };
      }
      console.error(`[studio run ${run}] ${name}: ${JSON.stringify(record.flows[name]).slice(0, 400)}`);
    }
    await studio.close(session);
  } finally {
    studio.disposeFixture(fixture);
  }
  record.after = systemSnapshot();
  results.push(record);
}
const json = JSON.stringify(results, null, 2);
if (values.out) writeFileSync(values.out, json);
else console.log(json);
