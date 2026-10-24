"use strict";

// Browser code mode: the agent writes JavaScript against a Playwright-style
// browser API in a persistent session (src/main/browser/code/). The full API
// is served by browser.documentation() inside the session, so this
// description stays short. Entries follow the contract in ./index.cjs.

const CODE_MAX_TIMEOUT_MS = 110_000;

module.exports = {
  order: 5,
  budget: 400,
  tools: [
    {
      name: "codara_browser_use",
      rpc: "browser.use",
      annotations: { destructive: true, openWorld: true },
      description:
        "Run JavaScript on a Playwright-style browser API (network and CDP too); one call runs whole flows, bindings persist. Read browser.documentation() first.",
      inputSchema: {
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string" },
          timeoutMs: { type: "number", maximum: CODE_MAX_TIMEOUT_MS },
          reset: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    // The locator lookups and DevTools protocol calls codara_browser_use's
    // snippets make.
    { name: "codara_preview_locate", rpc: "preview.locate", hidden: true },
    { name: "codara_preview_cdp", rpc: "preview.cdp", hidden: true },
    { name: "codara_preview_cdp_events", rpc: "preview.cdp_events", hidden: true },
  ],
};
