"use strict";

// Dev servers Codara keeps running for a workspace and the status of
// Codara's tools. Names start with codara_terminal_ so Cora loads them with
// the terminal family; each one that starts a process belongs in
// FENCE_BRIDGE_SHELL (resources/pi-cora/worker-policy.ts). Entries follow
// the contract in ./index.cjs.

module.exports = {
  order: 900,
  family: "studio",
  budget: 1100,
  tools: [],
};
