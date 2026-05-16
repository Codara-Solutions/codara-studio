"use strict";

const { runLiveAdapter } = require("./_live.cjs");

async function run(input) {
  return runLiveAdapter("codex_single", input);
}

module.exports = { run };

