"use strict";

// Tabs and tab groups by their link (codara://tab/... or codara://group/...),
// which the user copies from a tab's menu and codara_terminal_list and
// codara_preview_list return. Not in a Cora family and not worker-safe
// (resources/pi-cora/worker-policy.ts): it can close the user's tabs. Entries
// follow the contract in ./index.cjs.

module.exports = {
  order: 910,
  family: "studio",
  budget: 508,
  tools: [
    {
      name: "codara_tab",
      rpc: "tab.action",
      description:
        "A tab or group by codara:// link or tabId. info: its tabs, panes. focus: show the user. close: it or the group's tabs. split: beside the tab on screen. unsplit. Tabs you did not open need the user's approval.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["info", "focus", "close", "split", "unsplit"] },
          link: { type: "string" },
          direction: { type: "string", enum: ["right", "down"] },
        },
        required: ["action", "link"],
        additionalProperties: false,
      },
      annotations: { destructive: true },
    },
  ],
};
