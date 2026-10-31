#!/usr/bin/env node
"use strict";

// cora: a terminal coding harness that runs by itself, with no Studio app.
//
//   cora                      interactive session in the current folder
//   cora exec "prompt"        one-shot run
//   cora studio <command>     drive a running Codara Studio (studio.cjs)
//
// This file stays dependency free so `--help`, `--version` and `studio` never
// load the agent engine.

const HELP = `cora: a coding agent in your terminal

  cora [prompt]                      interactive session in this folder
  cora exec [prompt]                 one-shot run; prompt from stdin when omitted
  cora resume [id]                   continue a session (picker without an id)
  cora login [claude|chatgpt]        sign in; no provider lists what is signed in
  cora logout <claude|chatgpt>       remove a Cora sign-in
  cora models [search]               list the models you can use
  cora studio <command>              drive a running Codara Studio (cora studio help)

Options
  --model NAME        sonnet, opus, luna, sol, or any provider/id
  --effort LEVEL      off, minimal, low, medium, high, xhigh, max
  --resume [id]       same as cora resume; works with exec
  -c, --continue      continue the most recent session
  --json              exec: one JSON event per line, ending with cora_result
  --mcp-config FILE   add MCP servers from a file (.mcp.json format)
  -v, --version       print the version

exec exit codes
  0  finished, and the model did not report otherwise
  1  a provider or runtime failure stopped the run
  2  bad usage or no sign-in
  3  the model reported partial, blocked or failed

Files live in ~/.cora (CORA_HOME): auth.json, settings.json, models.json,
mcp.json, skills/, sessions/.
`;

function main() {
  const argv = process.argv.slice(2);
  const [first] = argv;
  if (first === "studio") return require("./studio.cjs").run(argv.slice(1));
  if (first === "help" || first === "--help" || first === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    console.log(require("./package.json").version);
    return;
  }
  if (!process.features.typescript) {
    console.error(`cora needs Node 22.18 or newer (this is ${process.version}).`);
    process.exitCode = 2;
    return;
  }
  import("./harness/main.mjs").then(({ run }) => run(argv)).catch((error) => {
    console.error(`cora: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

main();
