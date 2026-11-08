#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { isNoiseLine, createLineFilter } = require("./dev-log-filter.cjs");

const noise =
  "[9879:1108/185944.092505:ERROR:components/viz/service/display/display.cc:273] Frame latency is negative: -0.334 ms";
const other = "[9879:1108/185944.1:ERROR:gpu/command_buffer/service/shared_image.cc:12] Something else failed";

assert.equal(isNoiseLine(noise), true);
assert.equal(isNoiseLine(other), false);
assert.equal(isNoiseLine("Frame latency is negative"), false);

function run(chunks) {
  const out = [];
  const filter = createLineFilter((text) => out.push(text));
  for (const chunk of chunks) filter.push(chunk);
  filter.flush();
  return out.join("");
}

assert.equal(run([`${noise}\n${other}\nplain\n`]), `${other}\nplain\n`);

// A line split across chunks is judged whole, in both directions.
const cut = 40;
assert.equal(run([noise.slice(0, cut), `${noise.slice(cut)}\n${other}`.slice(0, 10), `${noise.slice(cut)}\n${other}`.slice(10)]), other);
assert.equal(run([other.slice(0, 15), `${other.slice(15)}\n`]), `${other}\n`);

// A partial line with no newline is released at the end, noise or not.
assert.equal(run(["tail"]), "tail");
assert.equal(run([noise]), "");

// Blank lines and colour codes survive.
assert.equal(run(["\n\x1b[31mred\x1b[0m\n"]), "\n\x1b[31mred\x1b[0m\n");

console.log("PASS dev log filter hides only Chromium frame-latency noise");
