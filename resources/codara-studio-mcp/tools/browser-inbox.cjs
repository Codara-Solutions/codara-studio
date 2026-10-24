"use strict";

// What the user sent this agent from Codara: picked elements, comments on a
// page, screenshots, tabs. A send to a pane is pasted into the agent's
// prompt; one sent to the inbox waits here until the agent pulls it.
// Entries follow the contract in ./index.cjs.

module.exports = {
  order: 50,
  budget: 400,
  tools: [
    {
      name: "codara_preview_inbox",
      rpc: "preview.inbox",
      description:
        "Read what the user queued for you from Codara (picked elements, page comments, screenshots), oldest first: text, source tab and URL, attached file paths. Read items are removed unless peek=true.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Default 20." },
          peek: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
  ],
};
