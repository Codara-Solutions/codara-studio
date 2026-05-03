// Adapter: noop
//
// Does nothing. Returns immediately with the seed repo unchanged.
// Useful for self-testing the harness pipeline (gates + result recording)
// without consuming model tokens.
//
// Not listed in suite manifests; invoke via `--adapter noop` only.

"use strict";

const runnerLib = require("../lib/runner");

function createRunner() {
  return {
    id: "noop",
    label: "Noop adapter (self-test only)",
    async run(input) {
      return {
        finalRepoPath: input.seedRepoPath,
        transcript: [
          runnerLib.event("noop:start", "noop adapter — leaving seed repo unchanged"),
        ],
        artifacts: [],
        attemptCount: 1,
        humanInterventions: 0,
        durationSeconds: 0.001,
        exitReason: "completed",
      };
    },
  };
}

module.exports = { createRunner };
