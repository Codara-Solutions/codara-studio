"use strict";

// Browser DevTools: console, network and viewport emulation.
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
        "Read the tab's console messages and uncaught errors, newest last (up to 500), recorded since the tab opened. Filter by level, trim with limit, or clear=true to reset.",
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
        "Read the tab's requests (url, method, status, mimeType, failure; up to 500), recorded since the tab opened. filter matches a URL substring; clear=true resets.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          limit: { type: "number", description: "Default 100, max 500." },
          filter: { type: "string" },
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
        "Resize the viewport to CSS-pixel dimensions, for example 375x667 for a phone layout. Returns the applied size.",
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
