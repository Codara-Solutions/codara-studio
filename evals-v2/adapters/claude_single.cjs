"use strict";

const { runLiveAdapter } = require("./_live.cjs");

async function run(input) {
  return runLiveAdapter("claude_single", input);
}

module.exports = { run };

