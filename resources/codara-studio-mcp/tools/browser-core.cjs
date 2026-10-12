"use strict";

// Browser core: list, navigate, read and act on a page by @reference.
// Entries follow the contract in ./index.cjs.

const { PREVIEW_WAIT_MAX_MS } = require("./lib/limits.cjs");

module.exports = {
  order: 10,
  budget: 4400,
  tools: [
    {
      name: "codara_preview_list",
      rpc: "preview.list",
      annotations: { readOnly: true },
      description:
        "List the browser tabs in your workspace: id, title, URL, isActive, and isLastViewed (the tab the user looked at last). When the user refers to an existing tab, match it here and pass its tabId to the other browser tools; ask if the reference is ambiguous.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "codara_preview_navigate",
      rpc: "preview.navigate",
      annotations: { openWorld: true },
      step: { order: 10 },
      description:
        "Load an http, https, or file URL in a browser tab. With tabId, reuse that tab; without it, reuse or open this session's tab. Waits briefly for dom-ready. Tabs stay open afterwards.",
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          tabId: { type: "string" },
          url: { type: "string", description: "Absolute URL to load." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_snapshot",
      rpc: "preview.snapshot",
      annotations: { readOnly: true },
      step: { order: 70 },
      description:
        "Read the page as a compact outline with @references, labels, values, and states. Pass an @reference as the selector of other browser tools. Hidden content is omitted. selector scopes to a section; since=<previous snapshotId> returns only the diff when smaller. Re-read after a stale reference; use a screenshot for visual content.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          mode: { type: "string", enum: ["outline"] },
          maxBytes: { type: "number", description: "Default 12000." },
          selector: { type: "string" },
          since: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_click",
      rpc: "preview.click",
      step: { order: 20 },
      description:
        "Click one element by @reference or unique CSS selector with DOM events, after waiting briefly for it to be visible and enabled. Ambiguous, stale, disabled, or covered targets fail. Use codara_preview_mouse when the page needs trusted native input.",
      inputSchema: {
        type: "object",
        required: ["selector"],
        properties: {
          tabId: { type: "string" },
          selector: { type: "string", description: "@reference or unique CSS selector." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_type",
      rpc: "preview.type",
      step: { order: 30 },
      description:
        "Type text into an input, textarea, or contentEditable (by @reference or unique CSS selector), or pick a native dropdown option by its exact value. clearFirst empties a text field first.",
      inputSchema: {
        type: "object",
        required: ["selector", "text"],
        properties: {
          tabId: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
          clearFirst: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_press_key",
      rpc: "preview.press_key",
      step: { order: 40 },
      description:
        "Send one key (Enter, Escape, Tab, ArrowUp, Backspace, or a single character) to the focused element or to selector. Uses trusted input when available; codara_preview_key adds modifiers.",
      inputSchema: {
        type: "object",
        required: ["key"],
        properties: {
          tabId: { type: "string" },
          key: { type: "string" },
          selector: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_evaluate",
      rpc: "preview.evaluate",
      annotations: { destructive: true, openWorld: true },
      step: { order: 50 },
      description:
        "Run JavaScript in the page and return the last expression's value as JSON. Set awaitPromise to await an async expression.",
      inputSchema: {
        type: "object",
        required: ["code"],
        properties: {
          tabId: { type: "string" },
          code: { type: "string" },
          awaitPromise: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_wait_for",
      rpc: "preview.wait_for",
      annotations: { readOnly: true },
      step: { order: 60 },
      description:
        "Wait until a selector is attached, visible (default), or hidden, or until timeoutMs passes.",
      inputSchema: {
        type: "object",
        required: ["selector"],
        properties: {
          tabId: { type: "string" },
          selector: { type: "string" },
          state: { type: "string", enum: ["attached", "visible", "hidden"] },
          timeoutMs: { type: "number", maximum: PREVIEW_WAIT_MAX_MS, description: `Default 5000, max ${PREVIEW_WAIT_MAX_MS}.` },
        },
        additionalProperties: false,
      },
    },
    // Callable for agents and prompts that already use it, but no longer
    // listed: codara_preview_list returns every tab's URL and title.
    { name: "codara_preview_url", rpc: "preview.url", hidden: true },
  ],
};
