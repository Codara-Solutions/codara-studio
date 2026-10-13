"use strict";

// The agent side of pointing at the page. Elements the user picked and
// boxes drawn on the page arrive as a paste or through codara_preview_inbox
// (./browser-inbox.cjs); codara_preview_inspect gives an agent the same
// description for any element it chooses. Entries follow the contract in
// ./index.cjs.

module.exports = {
  order: 70,
  budget: 300,
  tools: [
    {
      name: "codara_preview_inspect",
      rpc: "preview.inspect",
      annotations: { readOnly: true },
      description: "Describe an element (ref, selector or x,y) to edit it: box model, styles, CSS rules, source file:line, image.",
      inputSchema: {
        type: "object",
        properties: { tabId: { type: "string" }, ref: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
      },
    },
  ],
};
