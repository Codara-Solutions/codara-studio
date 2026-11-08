"use strict";

// Chromium logs this on Wayland when presentation timestamps run slightly
// ahead of its own clock. It is harmless and floods the dev terminal. Only this
// message is dropped; every other line, including other ERROR lines, passes.
const NOISE = /display\.cc:\d+\] Frame latency is negative/;

function isNoiseLine(line) {
  return NOISE.test(line);
}

// Line-buffered filter: a chunk may end mid-line, so the tail waits for its
// newline. `write` gets the kept text, `flush` releases a final unterminated line.
function createLineFilter(write) {
  let pending = "";
  const emit = (line, terminator) => {
    if (!isNoiseLine(line)) write(line + terminator);
  };
  return {
    push(chunk) {
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        emit(pending.slice(0, index), "\n");
        pending = pending.slice(index + 1);
      }
    },
    flush() {
      if (pending) emit(pending, "");
      pending = "";
    },
  };
}

module.exports = { isNoiseLine, createLineFilter };
