"use strict";

// Browser DevTools: console, network and viewport size.
// Entries follow the contract in ./index.cjs.

module.exports = {
  order: 40,
  budget: 3000,
  tools: [
    {
      name: "codara_preview_console",
      rpc: "preview.console",
      annotations: { readOnly: true },
      description:
        "Read the tab's console messages and uncaught errors since it opened (up to 500). Filter by level; clear=true resets.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          limit: { type: "number", description: "Default 100, max 500." },
          level: { type: "string", enum: ["debug", "info", "warning", "error"] },
          clear: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_network",
      rpc: "preview.network",
      annotations: { readOnly: true },
      description:
        "Read the tab's requests since it opened (up to 500). Filter: filter (URL part), type (xhr,fetch), status (404, 4xx, >=400), failed=true (errors, 4xx, 5xx). id=<row id>: headers, timings, initiator, body (body=false skips). har=true saves a HAR 1.2 file. Cookie and authorization values are redacted unless redact=false.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          limit: { type: "number" },
          filter: { type: "string" },
          type: { type: "string" },
          status: { type: "string" },
          failed: { type: "boolean" },
          id: { type: "string" },
          body: { type: "boolean" },
          har: { type: "boolean" },
          redact: { type: "boolean" },
          clear: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_resize",
      rpc: "preview.resize",
      annotations: { idempotent: true },
      step: { order: 120 },
      description:
        "Resize the viewport to CSS pixels, such as 375x667 for a phone layout.",
      inputSchema: {
        type: "object",
        required: ["width", "height"],
        properties: {
          tabId: { type: "string" },
          width: { type: "number" },
          height: { type: "number" },
        },
        additionalProperties: false,
      },
    },
  ],
};
