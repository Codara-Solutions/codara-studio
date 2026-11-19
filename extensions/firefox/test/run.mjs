// The Firefox extension's own tests, run in Node:
//
//   node extensions/firefox/test/run.mjs
//
// The real extension in a headless Firefox, linked to Codara, is covered by
// tests/e2e/firefox-extension.spec.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assemble } from "../build/assemble.mjs";
import * as assembling from "./assemble.test.mjs";
import * as firefox from "./firefox.test.mjs";
import * as manifest from "./manifest.test.mjs";

const scratch = mkdtempSync(join(tmpdir(), "codara-firefox-test-"));
let failed = false;
try {
  const { dir } = assemble(join(scratch, "extension"));
  for (const suite of [firefox, manifest, assembling]) {
    try {
      console.log(`ok - ${await suite.run(dir)}`);
    } catch (error) {
      failed = true;
      console.error("not ok -", error);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
