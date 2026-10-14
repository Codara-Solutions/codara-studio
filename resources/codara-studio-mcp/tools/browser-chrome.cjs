"use strict";

// The user's own browser, reached through Codara's browser extension. Every
// browser tool already takes a "chrome:<tabId>" tabId; the tool here covers
// what only the extension link has (its state, opening, closing and
// bringing forward a tab). Entries follow the contract in ./index.cjs.

module.exports = {
  order: 80,
  budget: 530,
  tools: [
    {
      name: "codara_preview_chrome",
      rpc: "preview.chrome",
      annotations: { openWorld: true },
      description:
        "The user's own browser via the Codara extension: status (connection, shared chrome: tabs), open a URL in a new tab, close a tab an agent opened, or activate a shared tab.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["status", "open", "close", "activate"] },
          url: { type: "string" },
          group: { type: "string", description: "Tab group for an opened tab." },
          tabId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  ],
};
