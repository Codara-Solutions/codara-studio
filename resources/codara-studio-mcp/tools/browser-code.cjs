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
      name: "codara_preview_code",
      rpc: "preview.code",
      annotations: { destructive: true, openWorld: true },
      description:
        "Run JavaScript on a Playwright-style browser API; one call runs a whole flow and bindings persist. Read browser.documentation() first.",
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
    // The locator lookups codara_preview_code's snippets make.
    { name: "codara_preview_locate", rpc: "preview.locate", hidden: true },
  ],
};
