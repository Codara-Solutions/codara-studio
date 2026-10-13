"use strict";

// The user's own Chrome, reached through Codara's browser extension. Every
// browser tool already takes a "chrome:<tabId>" tabId; tools here cover what
// only the extension link has (connection state, attaching a tab). Entries
// follow the contract in ./index.cjs.

module.exports = {
  order: 80,
  budget: 600,
  tools: [],
};
