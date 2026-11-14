#!/usr/bin/env node
// Measures what one terminal full of output costs in memory with xterm's
// headless build, which keeps the same buffer the renderer's xterm does.
// Each line limit runs in its own child process, so one measurement never
// sees another's garbage. Not part of the test registry; run it by hand:
//
//   node scripts/measure-terminal-scrollback-memory.mjs [--cols 200] [--rows 50] [limit ...]
//
// With no limits it compares the old default (10,000 lines) with the current
// defaults from src/shared/types.ts.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const OLD_DEFAULT = 10_000;
const MB = 1024 * 1024;

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  args.splice(index, 2);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} needs a positive whole number`);
  return value;
}

function sharedDefault(name) {
  const source = readFileSync(join(here, "..", "src", "shared", "types.ts"), "utf8");
  const match = source.match(new RegExp(`export const ${name} = ([\\d_]+);`));
  if (!match) throw new Error(`${name} not found in src/shared/types.ts`);
  return Number(match[1].replaceAll("_", ""));
}

// One line of colored, full-width output, like an agent transcript.
function outputLine(index, cols) {
  const text = `${String(index).padStart(6, "0")} `.padEnd(cols, "abcdefghij klmnopqrst uvwxyz 0123456789 ");
  return `\x1b[3${index % 8}m${text.slice(0, 40)}\x1b[0m${text.slice(40, cols)}\r\n`;
}

async function measureOne(limit, cols, rows) {
  const { Terminal } = require("@xterm/headless");
  const used = () => {
    globalThis.gc();
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.external;
  };
  const before = used();
  const term = new Terminal({ cols, rows, scrollback: limit, allowProposedApi: true });
  const total = limit + rows;
  const chunk = [];
  for (let i = 0; i < total; i += 1) {
    chunk.push(outputLine(i, cols));
    if (chunk.length === 500 || i === total - 1) {
      const data = chunk.join("");
      chunk.length = 0;
      await new Promise((resolve) => term.write(data, resolve));
    }
  }
  const retained = term.buffer.active.length;
  const after = used();
  term.dispose();
  return { limit, cols, rows, retained, bytes: after - before };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--child") {
    const [, limit, cols, rows] = args.map(Number);
    process.stdout.write(JSON.stringify(await measureOne(limit, cols, rows)));
    return;
  }
  const cols = option(args, "--cols", 200);
  const rows = option(args, "--rows", 50);
  const limits = args.length > 0
    ? args.map(Number)
    : [
      OLD_DEFAULT,
      sharedDefault("TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT"),
      sharedDefault("TERMINAL_SCROLLBACK_LINE_LIMIT_LOW_MEMORY_DEFAULT"),
    ];
  const xtermVersion = require("@xterm/headless/package.json").version;
  console.log(`@xterm/headless ${xtermVersion}, ${cols} columns x ${rows} rows, every line full\n`);
  console.log("scrollback lines  retained lines  MB per full terminal");
  for (const limit of limits) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`not a line limit: ${limit}`);
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", fileURLToPath(import.meta.url), "--child", String(limit), String(cols), String(rows)],
      { encoding: "utf8" },
    );
    if (child.status !== 0) throw new Error(child.stderr || `measurement for ${limit} lines failed`);
    const result = JSON.parse(child.stdout);
    console.log(
      `${String(limit).padStart(16)}  ${String(result.retained).padStart(14)}  ${(result.bytes / MB).toFixed(1).padStart(20)}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
