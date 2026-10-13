"use strict";

// Audits and performance: accessibility and page-quality audits, traces with
// Core Web Vitals, memory snapshots. All of them run against a background
// tab. Entries follow the contract in ./index.cjs.

module.exports = {
  order: 60,
  budget: 1100,
  tools: [
    {
      name: "codara_preview_audit",
      rpc: "preview.audit",
      annotations: { readOnly: true },
      description:
        "Audit the tab's accessibility or page quality, even in the background. accessibility: axe-core failures by rule with element refs and contrast ratios. quality: performance, best-practice and SEO checks (not Lighthouse). Full report in path.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          kind: { type: "string", enum: ["accessibility", "quality"] },
        },
        additionalProperties: false,
      },
    },
  ],
};
