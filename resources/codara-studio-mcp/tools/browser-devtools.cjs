"use strict";

// Browser DevTools: console, network, emulation, storage and viewport size.
// Entries follow the contract in ./index.cjs.

module.exports = {
  order: 40,
  budget: 3070,
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
      name: "codara_preview_emulate",
      rpc: "preview.emulate",
      annotations: { idempotent: true },
      description:
        "Emulate conditions on the tab until reset; only passed fields change. device: phone, tablet, desktop, iphone-se, iphone-15, pixel-8, ipad-pro, none (size, pixel ratio, touch, mobile UA). network: offline, slow3g, fast3g, 4g, none, or ms/kbps/kbps for latency/down/up. cpu: slowdown factor. reset=true clears all first.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          colorScheme: { type: "string", enum: ["light", "dark", "none"] },
          reducedMotion: { type: "boolean" },
          network: { type: "string" },
          cpu: { type: "number" },
          device: { type: "string" },
          deviceScaleFactor: { type: "number" },
          mobile: { type: "boolean" },
          touch: { type: "boolean" },
          reset: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_storage",
      rpc: "preview.storage",
      description:
        "Read or change the tab origin's storage. get (default) lists every area; set writes name=value in area cookies, local or session; clear empties area (default all) or one name. fresh opens url in a new logged-out tab with a temporary session and returns its tabId; discard closes it and wipes its data. Secrets are redacted unless redact=false.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          action: { type: "string", enum: ["get", "set", "clear", "fresh", "discard"] },
          area: { type: "string", enum: ["cookies", "local", "session", "indexeddb", "cache"] },
          name: { type: "string" },
          value: { type: "string" },
          url: { type: "string" },
          group: { type: "string", description: "Tab group for the fresh tab." },
          redact: { type: "boolean" },
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
