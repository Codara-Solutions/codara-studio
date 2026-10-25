"use strict";

// Browser capture: screenshots, before/after diffs, sizes side by side and
// flow recordings. Entries follow the contract in ./index.cjs.

const tab = { type: "string" };
const img = {
  format: { type: "string", enum: ["jpeg", "png", "webp"] },
  quality: { type: "number" },
  maxWidth: { type: "number" },
};
const what = {
  fullPage: { type: "boolean" },
  selector: { type: "string", description: "@ref or unique selector" },
  clip: { type: "object", description: "{x,y,width,height} CSS px" },
};

module.exports = {
  order: 20,
  budget: 2125,
  tools: [
    {
      name: "codara_preview_screenshot",
      rpc: "preview.screenshot",
      annotations: { readOnly: true },
      step: { order: 80, properties: { fullPage: what.fullPage, format: img.format } },
      description:
        "The tab (or fullPage, one element, a clip region) as an image, also saved to path. Default JPEG q70, 1280 px wide; scale: image px per CSS px.",
      inputSchema: {
        type: "object",
        properties: { tabId: tab, ...img, scale: { type: "number" }, ...what },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_compare",
      rpc: "preview.compare",
      annotations: { readOnly: true },
      description:
        "Before/after a change, or across screen sizes. baseline saves one per viewport; diff (default): percent changed, regions, marked image; sizes: all sizes in one image; list: baselines.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: tab,
          mode: { type: "string", enum: ["baseline", "diff", "sizes", "list"] },
          name: { type: "string" },
          ...what,
          threshold: { type: "number", description: "0-1" },
          sizes: { type: "array", items: { type: "string" }, description: "phone, tablet, desktop or WxH" },
          colorScheme: { type: "string", enum: ["light", "dark", "both"] },
          ...img,
        },
        additionalProperties: false,
      },
    },
    {
      name: "codara_preview_record",
      rpc: "preview.record",
      annotations: { readOnly: true },
      step: { order: 85, properties: { stop: { type: "boolean" } } },
      description:
        "Record the tab to GIF (default), MP4 or WebM. Call to start, act, then call with stop:true for the path.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: tab,
          stop: { type: "boolean" },
          format: { type: "string", enum: ["gif", "mp4", "webm"] },
          fps: { type: "number", description: "max 30" },
          maxSeconds: { type: "number", description: "default 30" },
          maxWidth: { type: "number" },
        },
        additionalProperties: false,
      },
    },
  ],
};
