"use strict";

// Browser core: list, navigate, read and act on a page by @reference.
// Entries follow the contract in ./index.cjs.

const { PREVIEW_WAIT_MAX_MS } = require("./lib/limits.cjs");

module.exports = {
  order: 10,
  budget: 4540,
  tools: [
    {
      name: "codara_preview_list",
      rpc: "preview.list",
      annotations: { readOnly: true },
      description:
        "List your workspace's browser tabs, then ones the user shared from Chrome (kind \"chrome\"): id, title, URL, group, isActive, isLastViewed. Match the user's references here and pass that tabId; ask if ambiguous.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "codara_preview_navigate",
      rpc: "preview.navigate",
      annotations: { openWorld: true },
      step: { order: 10, properties: { group: { type: "string" } } },
      description:
        "Load an http, https or file URL in tabId, or in this session's tab (opened if needed). Waits briefly for dom-ready.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          url: { type: "string", description: "Absolute URL to load." },
          group: { type: "string", description: "Tab group for the tab this opens, or for tabId (url then optional). Name it after your task." },
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
        "Read the page as a compact outline: @references, labels, values, states, link targets. Pass an @reference as another tool's selector. selector scopes it; since=<snapshotId> returns only the diff. Re-read after a stale reference.",
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
        "Click one element (@reference or unique CSS selector) with DOM events once visible and enabled; ambiguous, stale, disabled or covered targets fail. codara_preview_mouse sends trusted native clicks.",
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
        "Type text into an input, textarea or contentEditable (@reference or unique selector), or pick a native dropdown option by exact value. clearFirst empties the field.",
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
        "Send one key (Enter, Escape, Tab, ArrowUp, Backspace or a character) to the focused element or selector, as trusted input when possible. codara_preview_key does chords.",
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
      step: {
        order: 60,
        properties: {
          fresh: { type: "boolean" },
          text: { type: "string" },
          navigation: { type: "boolean" },
          load: { type: "string" },
          stableMs: { type: "number" },
          hmr: { type: "boolean" },
        },
      },
      description:
        "Wait until all given conditions hold; a timeout says what it saw. selector (+state); fresh: only elements new or re-rendered with new text since your last action. text: contains it (or /regex/). url: exact, path, * glob, /regex/. navigation: committed since your last action. load. stableMs. hmr: dev-server update settled.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          selector: { type: "string" },
          state: { type: "string", enum: ["attached", "visible", "hidden"] },
          fresh: { type: "boolean" },
          text: { type: "string" },
          url: { type: "string" },
          navigation: { type: "boolean" },
          load: { type: "string", enum: ["domcontentloaded", "load", "networkidle"] },
          stableMs: { type: "number" },
          hmr: { type: "boolean" },
          timeoutMs: { type: "number", maximum: PREVIEW_WAIT_MAX_MS, description: "Default 5000, or 15000 with navigation/load/hmr." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_find",
      rpc: "preview.find",
      annotations: { readOnly: true },
      step: { order: 65, properties: { query: { type: "string" } } },
      description:
        "Find elements by description (\"the search button\"): ranked @references with role, name and box.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          tabId: { type: "string" },
          query: { type: "string" },
          limit: { type: "number", description: "Default 5." },
        },
        additionalProperties: false,
      },
    },
    // Callable for agents and prompts that already use it, but no longer
    // listed: codara_preview_list returns every tab's URL and title.
    { name: "codara_preview_url", rpc: "preview.url", hidden: true },
  ],
};
