"use strict";

// A deterministic clock for suites that drive timer-heavy main-process code
// (quiet windows, sweeps, confirmation delays). It replaces the global timer
// functions and Date for the whole process, so code bundled with esbuild and
// required afterwards runs on it without any change.
//
//   const clock = require("./fake-clock.cjs").installFakeClock();
//   const mod = require(bundle);           // install BEFORE loading the code
//   await clock.advance(4_500);            // instead of a real sleep
//
// advance(ms) fires every timer that falls due inside the window in due
// order, moving Date.now() to each timer's due time before it runs, and lets
// promise chains and pending I/O callbacks settle after each one. A suite
// therefore sees the same sequence of events as with real waits, minus the
// scheduling jitter, which is what made the real-time versions slow and
// occasionally flaky under load.

function installFakeClock({ start = Date.now() } = {}) {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    Date: globalThis.Date,
  };
  let now = start;
  let seq = 0;
  const timers = new Map();

  class FakeTimeout {
    constructor(id) {
      this.id = id;
    }
    ref() {
      return this;
    }
    unref() {
      return this;
    }
    hasRef() {
      return true;
    }
    refresh() {
      const t = timers.get(this.id);
      if (t) t.due = now + t.ms;
      return this;
    }
    close() {
      timers.delete(this.id);
      return this;
    }
    [Symbol.toPrimitive]() {
      return this.id;
    }
  }

  function add(fn, ms, args, repeat) {
    if (typeof fn !== "function") throw new TypeError("callback must be a function");
    // Node treats delays below 1 ms (and NaN) as 1 ms.
    const delay = Number(ms) >= 1 ? Math.floor(Number(ms)) : 1;
    const id = ++seq;
    timers.set(id, { id, fn, args, ms: delay, due: now + delay, repeat });
    return new FakeTimeout(id);
  }
  function clear(handle) {
    if (handle == null) return;
    timers.delete(typeof handle === "object" ? handle.id : Number(handle));
  }

  class FakeDate extends real.Date {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() {
      return now;
    }
  }

  globalThis.setTimeout = (fn, ms, ...args) => add(fn, ms, args, false);
  globalThis.setInterval = (fn, ms, ...args) => add(fn, ms, args, true);
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  globalThis.Date = FakeDate;

  const settle = async () => {
    // Two macrotask turns: microtasks queued by the callback drain before the
    // first, and callbacks those schedule with setImmediate run before the
    // second.
    for (let i = 0; i < 2; i += 1) await new Promise((resolve) => real.setImmediate(resolve));
  };

  function nextDue(limit) {
    let best = null;
    for (const t of timers.values()) {
      if (t.due > limit) continue;
      if (!best || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t;
    }
    return best;
  }

  return {
    now: () => now,
    pending: () => timers.size,
    async advance(ms) {
      const target = now + Math.max(0, Number(ms) || 0);
      await settle();
      for (;;) {
        const t = nextDue(target);
        if (!t) break;
        now = Math.max(now, t.due);
        if (t.repeat) t.due = now + t.ms;
        else timers.delete(t.id);
        t.fn(...t.args);
        await settle();
      }
      now = target;
      await settle();
    },
    uninstall() {
      Object.assign(globalThis, {
        setTimeout: real.setTimeout,
        clearTimeout: real.clearTimeout,
        setInterval: real.setInterval,
        clearInterval: real.clearInterval,
        Date: real.Date,
      });
    },
    real,
  };
}

module.exports = { installFakeClock };
