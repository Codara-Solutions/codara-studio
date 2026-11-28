// node scripts/bench-snappy/flames.mjs DIR
//
// For each DIR/profiles/*.cpuprofile: inclusive time per function and self
// time per source module (DIR/profiles/*.summary.json), and a flame graph
// (*.svg, plus *.png drawn by Electron on the virtual display).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const IGNORE = new Set(["(idle)", "(program)", "(root)"]);

export function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function index(profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  return { nodes, parent };
}

const label = (frame) => `${frame.functionName || "(anonymous)"} ${frame.url.replace(/^.*\/(assets|src|node_modules)\//, "$1/")}:${frame.lineNumber + 1}`;

const moduleOf = (frame) => {
  const url = frame.url || "";
  const pkg = url.match(/node_modules\/((@[^/]+\/)?[^/]+)/);
  if (pkg) return pkg[1];
  if (!url) return frame.functionName || "(native)";
  return url.replace(/^.*\/(src|assets)\//, "$1/");
};

export function summary(profile, limit = 25) {
  const { nodes, parent } = index(profile);
  const deltas = profile.timeDeltas ?? [];
  const inclusive = new Map();
  const selfByModule = new Map();
  let busy = 0;
  profile.samples.forEach((id, i) => {
    const ms = (deltas[i] ?? 0) / 1000;
    const leaf = nodes.get(id);
    if (IGNORE.has(leaf.callFrame.functionName)) return;
    busy += ms;
    const mod = moduleOf(leaf.callFrame);
    selfByModule.set(mod, (selfByModule.get(mod) ?? 0) + ms);
    const seen = new Set();
    for (let n = id; n !== undefined; n = parent.get(n)) {
      const key = label(nodes.get(n).callFrame);
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + ms);
    }
  });
  const top = (map) => [...map.entries()].filter(([k]) => !k.startsWith("(root)")).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, v]) => ({ name: k, ms: Math.round(v * 10) / 10 }));
  const span = (profile.endTime - profile.startTime) / 1000;
  return { spanMs: Math.round(span), busyMs: Math.round(busy), busyPct: Math.round((busy / span) * 1000) / 10, inclusive: top(inclusive), selfByModule: top(selfByModule) };
}

// Merged call tree (same function under same parent merged), idle dropped.
function tree(profile) {
  const { nodes } = index(profile);
  const deltas = profile.timeDeltas ?? [];
  const selfMs = new Map();
  profile.samples.forEach((id, i) => selfMs.set(id, (selfMs.get(id) ?? 0) + (deltas[i] ?? 0) / 1000));
  // Frames inside a library are shown as one frame per run of that library
  // (React's work loop alone is 20 frames deep); app frames keep their names.
  const nameOf = (frame) => {
    const pkg = (frame.url || "").match(/node_modules\/((@[^/]+\/)?[^/]+)/);
    return pkg ? `[${pkg[1]}]` : label(frame);
  };
  const add = (node, sub) => {
    const existing = node.children.get(sub.name);
    if (existing) merge(existing, sub);
    else node.children.set(sub.name, sub);
  };
  const build = (n) => {
    const node = { name: nameOf(n.callFrame), self: selfMs.get(n.id) ?? 0, children: new Map() };
    for (const c of n.children ?? []) {
      const child = nodes.get(c);
      if (IGNORE.has(child.callFrame.functionName)) continue;
      const sub = build(child);
      if (sub.name === node.name && sub.name.startsWith("[")) {
        node.self += sub.self;
        for (const grand of sub.children.values()) add(node, grand);
      } else add(node, sub);
    }
    node.total = node.self + [...node.children.values()].reduce((s, c) => s + c.total, 0);
    return node;
  };
  const merge = (a, b) => {
    a.self += b.self;
    a.total += b.total;
    for (const [k, v] of b.children) {
      const e = a.children.get(k);
      if (e) merge(e, v);
      else a.children.set(k, v);
    }
  };
  return build(profile.nodes[0]);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function flameSvg(profile, { title, width = 1200, row = 16, minMs = 0.5, maxDepth = 45 } = {}) {
  const root = tree(profile);
  const rects = [];
  let depthMax = 0;
  const walk = (node, x, depth) => {
    if (depth > maxDepth) return;
    depthMax = Math.max(depthMax, depth);
    rects.push({ x, depth, ms: node.total, name: node.name });
    let cx = x;
    for (const child of [...node.children.values()].sort((a, b) => b.total - a.total)) {
      if (child.total >= minMs) walk(child, cx, depth + 1);
      cx += child.total;
    }
  };
  walk(root, 0, 0);
  const scale = width / Math.max(1, root.total);
  const height = (depthMax + 1) * row + 30;
  const color = (name) => {
    let h = 0;
    for (const ch of name.split(" ")[1] ?? name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    const hue = name.startsWith("[") ? 30 + (h % 30) : name.includes("src/") ? 190 + (h % 40) : 0 + (h % 20);
    return `hsl(${hue} 70% 62%)`;
  };
  const body = rects
    .filter((r) => r.ms * scale >= 0.6)
    .map((r) => {
      const x = r.x * scale;
      const w = r.ms * scale;
      const y = 22 + r.depth * row;
      const text = w > 40 ? `<text x="${(x + 3).toFixed(1)}" y="${(y + row - 4).toFixed(1)}">${esc(r.name.slice(0, Math.floor(w / 6.2)))}</text>` : "";
      return `<g><title>${esc(r.name)} (${r.ms.toFixed(1)} ms)</title><rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${row - 1}" fill="${r.depth === 0 ? "#bbb" : color(r.name)}"/>${text}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, monospace" font-size="10"><text x="4" y="14" font-size="12" font-family="sans-serif">${esc(title ?? "")} (busy ${root.total.toFixed(0)} ms)</text>${body}</svg>`;
}

// Electron (not a browser) draws the SVGs, so no extra download is needed.
async function toPng(svgPaths) {
  const require = createRequire(import.meta.url);
  require("../virtual-display.cjs").useVirtualDisplay();
  const { _electron } = require("playwright");
  const main = join(fileURLToPath(new URL(".", import.meta.url)), "blank-window.cjs");
  const app = await _electron.launch({ args: [main], env: { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY } });
  const page = await app.firstWindow();
  for (const path of svgPaths) {
    const svg = readFileSync(path, "utf8");
    const [, width, height] = svg.match(/width="(\d+)" height="(\d+)"/);
    await page.setViewportSize({ width: Number(width), height: Math.min(Number(height), 1000) });
    await page.setContent(`<body style="margin:0;background:#fff">${svg}</body>`);
    await page.locator("svg").screenshot({ path: path.replace(/\.svg$/, ".png") });
  }
  await app.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(process.argv[2], "profiles");
  const svgs = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"))) {
    const profile = load(join(dir, file));
    const base = join(dir, file.replace(/\.cpuprofile$/, ""));
    writeFileSync(`${base}.summary.json`, JSON.stringify(summary(profile), null, 2));
    writeFileSync(`${base}.svg`, flameSvg(profile, { title: file.replace(/\.cpuprofile$/, ""), minMs: 1 }));
    svgs.push(`${base}.svg`);
  }
  await toPng(svgs);
  console.log(`${svgs.length} flame graphs in ${dir}`);
}
