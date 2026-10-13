"use strict";

// The agent side of pointing at the page: elements the user picked and
// boxes drawn on a screenshot arrive through codara_preview_inbox
// (./browser-inbox.cjs) or as a paste; tools here are for whatever an agent
// needs beyond that. Entries follow the contract in ./index.cjs.

module.exports = {
  order: 70,
  budget: 300,
  tools: [],
};
