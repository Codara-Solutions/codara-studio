"use strict";

// Chromium logs this on Wayland when presentation timestamps run slightly
// ahead of its own clock. It is harmless and floods the dev terminal. Only this
// message is dropped; every other line, including other ERROR lines, passes.
const NOISE = /^\[\d+:[^\]\s]*:ERROR:[\w/.-]*display\.cc:\d+\] Frame latency is negative/;

function isNoiseLine(line) {
  return NOISE.test(line);
}

// Line-buffered filter: a chunk may end mid-line, so a tail that could still
// become a Chromium log line (it starts with "[") waits for its newline. Any
// other tail, such as a prompt, is written at once and the rest of that line
// passes through. `write` gets the kept text, `flush` releases a final tail.
function createLineFilter(write) {
  let pending = "";
  let passthrough = false;
  const emit = (line, terminator) => {
    if (!isNoiseLine(line)) write(line + terminator);
  };
  return {
    push(chunk) {
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index);
        if (passthrough) write(line + "\n");
        else emit(line, "\n");
        passthrough = false;
        pending = pending.slice(index + 1);
      }
      if (pending && (passthrough || !pending.startsWith("["))) {
        write(pending);
        pending = "";
        passthrough = true;
      }
    },
    flush() {
      if (pending) emit(pending, "");
      pending = "";
      passthrough = false;
    },
  };
}

module.exports = { isNoiseLine, createLineFilter };
