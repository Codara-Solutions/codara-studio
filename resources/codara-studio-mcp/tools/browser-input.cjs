"use strict";

// Browser trusted input: mouse, wheel, drag, keyboard and file inputs, sent
// through the DevTools protocol so they reach a background tab.
// Entries follow the contract in ./index.cjs.

module.exports = {
  order: 30,
  budget: 3400,
  tools: [
    {
      name: "codara_preview_mouse",
      rpc: "preview.mouse",
      description:
        "Trusted mouse input (event.isTrusted=true) at a selector's center or at viewport CSS-pixel coordinates: click, dblclick, rightclick, down, or up.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          action: { type: "string", enum: ["click", "dblclick", "rightclick", "down", "up"], description: "Default click." },
          selector: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          modifiers: { type: "array", items: { type: "string" }, description: "shift, meta, control, alt." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_scroll",
      rpc: "preview.scroll",
      step: { order: 90 },
      description:
        "Trusted mouse-wheel scroll at a selector's center or at CSS-pixel coordinates. Positive deltaY scrolls down.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          selector: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          deltaX: { type: "number" },
          deltaY: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_hover",
      rpc: "preview.hover",
      step: { order: 100 },
      description:
        "Trusted mouse move over a selector's center or CSS-pixel coordinates, triggering real :hover styles, tooltips, and mouseenter handlers.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          selector: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_drag",
      rpc: "preview.drag",
      description:
        "Trusted drag from one point to another. Each endpoint is { selector } or { x, y } in CSS pixels.",
      inputSchema: {
        type: "object",
        required: ["from", "to"],
        properties: {
          tabId: { type: "string" },
          from: {
            type: "object",
            properties: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
            additionalProperties: false,
          },
          to: {
            type: "object",
            properties: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
            additionalProperties: false,
          },
          steps: { type: "number", description: "Intermediate moves (default 12, max 100)." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_key",
      rpc: "preview.key",
      step: { order: 110 },
      description:
        "Trusted keyboard input to the focused element: a named key or single character, with optional modifiers. To type a whole string into a field use codara_preview_type.",
      inputSchema: {
        type: "object",
        required: ["key"],
        properties: {
          tabId: { type: "string" },
          key: { type: "string" },
          text: { type: "string", description: "Printable text when it differs from key." },
          modifiers: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_upload",
      rpc: "preview.upload",
      annotations: { openWorld: true },
      description:
        "Set the files of an <input type=file>. paths are absolute paths on this machine; the page receives their contents, so only upload files the task needs.",
      inputSchema: {
        type: "object",
        required: ["selector", "paths"],
        properties: {
          tabId: { type: "string" },
          selector: { type: "string" },
          paths: { type: "array", minItems: 1, items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
  ],
};
