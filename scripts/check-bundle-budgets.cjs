#!/usr/bin/env node
"use strict";

// Bundle size budgets for the production build (`npm run build` → out/).
//
// Measures raw and gzip bytes of what users download and what the window
// parses before its first paint, and compares them with
// scripts/bundle-budgets.json. Any metric over its limit fails, with a table
// that says by how much. The CI workflow .github/workflows/budgets.yml runs
// it on every pull request into Cora.
//
//   node scripts/check-bundle-budgets.cjs                 # check out/
//   node scripts/check-bundle-budgets.cjs --json r.json   # also write the numbers
//   node scripts/check-bundle-budgets.cjs --update        # rewrite the limits to
//                                                          # today's size + headroom
//
// Raise a limit only on purpose, in the pull request that needs it, and say
// why there. Lowering one after a size win keeps the win from eroding.

const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_BUDGETS = path.join(__dirname, "bundle-budgets.json");

const METRICS = [
  { id: "renderer.entry", label: "Renderer entry chunk (index-*.js)" },
  { id: "renderer.startup", label: "Renderer startup set (entry, preloads, CSS)" },
  { id: "renderer.total", label: "Renderer, all files" },
  { id: "main.index", label: "Main process entry (index.js)" },
  { id: "main.total", label: "Main process, all files (chunks, workers)" },
  { id: "preload.total", label: "Preloads, all files" },
];

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

// Vite and esbuild append an 8-character content hash; a name without it
// stays the same from build to build, so reports can be compared.
function stableName(relative) {
  return relative.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/i, "$1");
}

function sizeOf(file, cache) {
  let size = cache.get(file);
  if (!size) {
    const bytes = fs.readFileSync(file);
    size = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
    cache.set(file, size);
  }
  return size;
}

function sum(files, cache) {
  return files.reduce(
    (total, file) => {
      const size = sizeOf(file, cache);
      return { raw: total.raw + size.raw, gzip: total.gzip + size.gzip };
    },
    { raw: 0, gzip: 0 },
  );
}

// What index.html makes the window fetch before React can render: the entry
// script, its modulepreloads and the stylesheets.
function startupFiles(rendererDir) {
  const html = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");
  const entry = [];
  const startup = [];
  for (const tag of html.match(/<(script|link)\b[^>]*>/g) ?? []) {
    const src = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (!src || /^[a-z]+:/i.test(src)) continue;
    const isScript = tag.startsWith("<script") && /type="module"/.test(tag);
    const isPreload = /rel="modulepreload"/.test(tag);
    const isStyle = /rel="stylesheet"/.test(tag);
    if (!isScript && !isPreload && !isStyle) continue;
    const file = path.join(rendererDir, src);
    if (!fs.existsSync(file)) throw new Error(`index.html references ${src}, which is not in ${rendererDir}`);
    if (isScript) entry.push(file);
    startup.push(file);
  }
  if (entry.length !== 1) throw new Error(`expected one module entry script in index.html, found ${entry.length}`);
  return { entry, startup };
}

function measure(outDir) {
  const rendererDir = path.join(outDir, "renderer");
  const mainDir = path.join(outDir, "main");
  const preloadDir = path.join(outDir, "preload");
  for (const dir of [rendererDir, mainDir, preloadDir]) {
    if (!fs.existsSync(dir)) throw new Error(`${dir} is missing; run npm run build first`);
  }
  const cache = new Map();
  const { entry, startup } = startupFiles(rendererDir);
  const mainIndex = path.join(mainDir, "index.js");
  const metrics = {
    "renderer.entry": sum(entry, cache),
    "renderer.startup": sum(startup, cache),
    "renderer.total": sum(walk(rendererDir), cache),
    "main.index": sum([mainIndex], cache),
    "main.total": sum(walk(mainDir), cache),
    "preload.total": sum(walk(preloadDir), cache),
  };
  const startupSet = new Set(startup);
  const seen = new Map();
  const chunks = [];
  for (const [area, dir] of [["renderer", rendererDir], ["main", mainDir], ["preload", preloadDir]]) {
    for (const file of walk(dir)) {
      if (!/\.(m?js|css)$/.test(file)) continue;
      let name = `${area}/${stableName(path.relative(dir, file).split(path.sep).join("/"))}`;
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      if (count > 1) name = `${name} #${count}`;
      chunks.push({ name, ...sizeOf(file, cache), startup: startupSet.has(file) || file === mainIndex });
    }
  }
  chunks.sort((a, b) => b.raw - a.raw);
  return { metrics, chunks };
}

function compare(metrics, budgets) {
  const rows = [];
  for (const { id, label } of METRICS) {
    const actual = metrics[id];
    const limit = budgets.metrics?.[id];
    for (const kind of ["raw", "gzip"]) {
      const max = limit?.[kind];
      rows.push({
        id,
        label,
        kind,
        actual: actual[kind],
        limit: typeof max === "number" ? max : null,
        over: typeof max === "number" && actual[kind] > max,
      });
    }
  }
  return rows;
}

function withHeadroom(metrics, headroom) {
  const next = {};
  for (const { id } of METRICS) {
    next[id] = {
      raw: Math.ceil((metrics[id].raw * (1 + headroom)) / 1000) * 1000,
      gzip: Math.ceil((metrics[id].gzip * (1 + headroom)) / 1000) * 1000,
    };
  }
  return next;
}

const kB = (bytes) => `${(bytes / 1000).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} kB`;

function formatTable(rows) {
  const lines = [
    "| Metric | Kind | Now | Limit | Used | Status |",
    "|---|---|---:|---:|---:|---|",
  ];
  for (const row of rows) {
    const used = row.limit ? `${((row.actual / row.limit) * 100).toFixed(1)}%` : "";
    const status = row.limit === null ? "no limit" : row.over ? `**over by ${kB(row.actual - row.limit)}**` : "ok";
    lines.push(`| ${row.label} | ${row.kind} | ${kB(row.actual)} | ${row.limit === null ? "" : kB(row.limit)} | ${used} | ${status} |`);
  }
  return lines.join("\n");
}

function formatChunks(chunks, top = 15) {
  const lines = ["| Chunk (hash removed) | Raw | Gzip | Loads at startup |", "|---|---:|---:|---|"];
  for (const chunk of chunks.slice(0, top)) {
    lines.push(`| ${chunk.name} | ${kB(chunk.raw)} | ${kB(chunk.gzip)} | ${chunk.startup ? "yes" : ""} |`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { out: path.join(ROOT, "out"), budgets: DEFAULT_BUDGETS, json: null, update: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update") options.update = true;
    else if (arg === "--out") options.out = path.resolve(argv[++i]);
    else if (arg === "--budgets") options.budgets = path.resolve(argv[++i]);
    else if (arg === "--json") options.json = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const budgets = JSON.parse(fs.readFileSync(options.budgets, "utf8"));
  const { metrics, chunks } = measure(options.out);

  if (options.update) {
    budgets.metrics = withHeadroom(metrics, budgets.headroom ?? 0.03);
    fs.writeFileSync(options.budgets, `${JSON.stringify(budgets, null, 2)}\n`);
    console.log(`Wrote ${path.relative(ROOT, options.budgets)} at today's size + ${((budgets.headroom ?? 0.03) * 100).toFixed(0)}%.`);
  }

  const rows = compare(metrics, budgets);
  const over = rows.filter((row) => row.over);
  const table = formatTable(rows);
  console.log(table);
  console.log("");
  console.log(formatChunks(chunks));

  if (options.json) {
    fs.mkdirSync(path.dirname(options.json), { recursive: true });
    fs.writeFileSync(options.json, `${JSON.stringify({ metrics, rows, chunks }, null, 2)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Bundle budgets\n\n${table}\n\n<details><summary>Largest chunks</summary>\n\n${formatChunks(chunks, 30)}\n\n</details>\n\n`,
    );
  }
  if (over.length > 0) {
    const inActions = process.env.GITHUB_ACTIONS === "true";
    for (const row of over) {
      const message =
        `${row.label} (${row.kind}) is ${kB(row.actual)}, over its ${kB(row.limit)} budget by ${kB(row.actual - row.limit)}. ` +
        "Load the new code lazily (a dynamic import) or, if the growth is intended, raise the limit in scripts/bundle-budgets.json in this pull request and say why.";
      console.log(inActions ? `::error title=Bundle budget::${message}` : `FAIL: ${message}`);
    }
    process.exit(1);
  }
  console.log(`\nAll ${rows.length} budgets hold.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`check-bundle-budgets: ${error.message}`);
    process.exit(2);
  }
}

module.exports = { measure, compare, withHeadroom, stableName, formatTable, METRICS };
