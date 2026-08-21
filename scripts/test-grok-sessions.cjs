#!/usr/bin/env node
"use strict";

// Grok Build session paths: encodeURIComponent of the absolute cwd, plus
// discover-newest-by-birthtime for a just-launched pane.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-grok-sessions-"));
const OUT = path.join(TMP, "grok-sessions.cjs");

buildSync({
  entryPoints: [path.join(ROOT, "src", "main", "orchestration", "grok-sessions.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: OUT,
});

const {
  encodeGrokCwd,
  grokSessionTranscriptPath,
  discoverGrokSessionForCwd,
} = require(OUT);

async function main() {
  const cwd = "/Users/etienne/Documents/Projects/Codara/codara-studio";
  assert.equal(
    encodeGrokCwd(cwd),
    encodeURIComponent(cwd),
    "Grok cwd encoding must match encodeURIComponent",
  );

  const home = path.join(TMP, "grok-home");
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const transcript = grokSessionTranscriptPath(cwd, sessionId, home);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{"type":"session_update"}\n');
  fs.writeFileSync(
    path.join(path.dirname(transcript), "summary.json"),
    JSON.stringify({
      info: { id: sessionId, cwd },
      generated_title: "Test session",
      updated_at: new Date().toISOString(),
    }),
  );

  const found = await discoverGrokSessionForCwd(cwd, Date.now() - 60_000, undefined, home);
  assert.equal(found?.sessionId, sessionId);
  assert.equal(found?.transcriptPath, transcript);

  const excluded = await discoverGrokSessionForCwd(
    cwd,
    Date.now() - 60_000,
    new Set([sessionId]),
    home,
  );
  assert.equal(excluded, null, "excluded session ids must not be rediscovered");

  console.log("PASS grok session encode + discover");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
