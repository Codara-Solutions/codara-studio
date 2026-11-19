// The extension's own tests, run in Node:
//
//   node extensions/chrome/test/run.mjs
//
// The real extension in a real Chromium, linked to Codara, is covered by
// tests/e2e/chrome-extension.spec.ts.

import * as groupTab from "./group-tab.test.mjs";
import * as linkClient from "./link-client.test.mjs";
import * as linkRaces from "./link-races.test.mjs";
import * as packing from "./pack.test.mjs";
import * as policy from "./policy.test.mjs";
import * as presence from "./presence.test.mjs";

const suites = [policy, presence, packing, groupTab, linkClient, linkRaces];

let failed = false;
for (const suite of suites) {
  try {
    console.log(`ok - ${await suite.run()}`);
  } catch (error) {
    failed = true;
    console.error("not ok -", error);
  }
}
process.exitCode = failed ? 1 : 0;
