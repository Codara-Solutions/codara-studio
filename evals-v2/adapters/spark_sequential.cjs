"use strict";

const { runLiveAdapter } = require("./_live.cjs");

async function run(input) {
  return runLiveAdapter("spark_sequential", input);
}

module.exports = { run };

