"use strict";

// The batched browser runner. Its step actions and their fields come from the
// other modules (a tool with `step` is callable as a step); the registry fills
// them in, so a module adds a step without editing this file.
// Entries follow the contract in ./index.cjs.

module.exports = {
  order: 1000,
  tools: [
    {
      name: "codara_preview_run",
      annotations: { destructive: true, openWorld: true },
      description:
        "Run an ordered batch of browser steps in ONE call instead of one call per click or key. Each step fires the same real input as its single tool, so prefer this for any multi-step flow, for example typing `7 / 2 =` and reading the display. Every step must obey the task's tool restrictions. Stops at the first failing step unless continueOnError. Returns one result per step; screenshot steps also come back as images.",
      inputSchema: {
        type: "object",
        required: ["steps"],
        properties: {
          tabId: { type: "string", description: "Default tab for steps without their own." },
          continueOnError: { type: "boolean" },
          steps: {
            type: "array",
            minItems: 1,
            description:
              "Each step is { action, ...the fields of the matching codara_preview_* tool }, e.g. {action:'press_key', key:'7'}, {action:'click', selector:'#equals'}, {action:'evaluate', code:\"document.querySelector('#lcd').textContent\"}.",
            items: {
              type: "object",
              required: ["action"],
              properties: {
                action: {
                  type: "string",
                  enum: [],
                },
                label: { type: "string", description: "Echoed back in the step result." },
                tabId: { type: "string" },
                url: { type: "string" },
                selector: { type: "string" },
                text: { type: "string" },
                clearFirst: { type: "boolean" },
                key: { type: "string" },
                code: { type: "string" },
                awaitPromise: { type: "boolean" },
                state: { type: "string" },
                timeoutMs: { type: "number" },
                mode: { type: "string", enum: ["outline"] },
                maxBytes: { type: "number", description: "Default 12000." },
                since: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
                deltaX: { type: "number" },
                deltaY: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                modifiers: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  ],
};
