"use strict";

const { runLiveAdapter } = require("./_live.cjs");

async function run(input) {
  return runLiveAdapter("spark_hybrid_parallel", input);
}

module.exports = { run };

