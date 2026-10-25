"use strict";

// Audits and performance: accessibility and page-quality audits, traces with
// Core Web Vitals, memory snapshots. All of them run against a background
// tab. Entries follow the contract in ./index.cjs.

module.exports = {
  order: 60,
  budget: 1085,
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
    {
      name: "codara_preview_performance",
      rpc: "preview.performance",
      description:
        "Measure the tab's Core Web Vitals, traces and memory. vitals: LCP, CLS, INP, FCP, TTFB with elements. load: trace a reload. start, then stop: trace an interaction. memory: heap over ms; snapshot=true adds a heap snapshot with top retainers. Trace files open in DevTools.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          tabId: { type: "string" },
          action: { type: "string", enum: ["vitals", "load", "start", "stop", "memory"] },
          ms: { type: "number", description: "load: wait limit. memory: sample time." },
          snapshot: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
  ],
};
