"use strict";

// Browser capture: screenshots.
// Entries follow the contract in ./index.cjs.

module.exports = {
  order: 20,
  budget: 2200,
  tools: [
    {
      name: "codara_preview_screenshot",
      rpc: "preview.screenshot",
      annotations: { readOnly: true },
      step: { order: 80 },
      description:
        "Capture the tab as a PNG, also saved to the file in path. Returns viewport (CSS pixels), imageSize, and scale: divide screenshot coordinates by scale before passing them to mouse tools.",
      inputSchema: {
        type: "object",
        properties: { tabId: { type: "string" } },
        additionalProperties: false,
      },
    },
  ],
};
