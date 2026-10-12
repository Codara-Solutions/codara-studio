// Guards the workflow sandbox (src/main/orchestration/workflow-sandbox*.ts):
// a workflow script is untrusted code that Cora may have written, so it must
// not reach require, process, the file system, the network or timers, must
// not see any host object, and must not be able to hang or exhaust main. The
// sandbox runs the real bundled QuickJS worker in a worker thread, exactly as
// the app does.
//
//   node scripts/test-workflow-sandbox.cjs

const { bundleModule, loadSandboxWorkerCode, check, finish } = require("./workflow-test-harness.cjs");

let sandboxMod;
let metaMod;

function run(body, options = {}) {
  return new Promise((resolve) => {
    const calls = [];
    const notes = [];
    let sandbox;
    const timer = setTimeout(() => {
      void sandbox.terminate();
      resolve({ ok: false, error: "test timeout", calls, notes });
    }, options.timeoutMs ?? 20_000);
    sandbox = sandboxMod.startWorkflowSandbox({
      body,
      args: options.args ?? null,
      children: options.children,
      limits: options.limits,
      budget: options.budget,
      handlers: {
        onCall(id, ctx, call) {
          calls.push({ id, ctx, call });
          const answer = options.agent ? options.agent(call, calls.length - 1) : { ok: true, value: { echo: call.prompt } };
          Promise.resolve(answer).then((reply) => sandbox.reply(id, reply));
        },
        onNote(ctx, op, value) {
          notes.push({ ctx, op, value });
        },
        onChild() {},
        onIdle() {},
        onDone(result) {
          clearTimeout(timer);
          resolve({ ...result, calls, notes });
        },
      },
    });
  });
}

async function main() {
  sandboxMod = await bundleModule("workflow-sandbox.ts");
  metaMod = await bundleModule("workflow-meta.ts");
  const workerCode = await loadSandboxWorkerCode();
  sandboxMod.setWorkflowSandboxWorkerCode(workerCode);

  // The thread runs this text with `eval: true`: anything but a builtin
  // require would resolve against the app's cwd, not the bundle.
  {
    const requires = [...workerCode.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    const builtin = new Set(require("node:module").builtinModules);
    const foreign = requires.filter((name) => !builtin.has(name.replace(/^node:/, "")));
    check("the worker bundle requires only node builtins", foreign.length === 0, foreign);
  }

  // No ambient capabilities.
  {
    const result = await run(`
      return {
        require: typeof require,
        process: typeof process,
        fetch: typeof fetch,
        setTimeout: typeof setTimeout,
        setInterval: typeof setInterval,
        setImmediate: typeof setImmediate,
        XMLHttpRequest: typeof XMLHttpRequest,
        WebSocket: typeof WebSocket,
        std: typeof std,
        os: typeof os,
        host: typeof __wfHost,
        note: typeof __wfNote,
        child: typeof __wfChild,
        globalProcess: typeof globalThis.process,
        viaFunction: typeof (Function("return this")().process),
        viaConstructor: typeof agent.constructor("return typeof require")(),
      };
    `);
    check("script runs and returns", result.ok, result.error);
    const v = result.value ?? {};
    for (const key of ["require", "process", "fetch", "setTimeout", "setInterval", "setImmediate", "XMLHttpRequest", "WebSocket", "std", "os", "host", "note", "child", "globalProcess", "viaFunction"]) {
      check(`no ${key} in the sandbox`, v[key] === "undefined", v[key]);
    }
    check("the Function constructor stays inside the guest realm", v.viaConstructor === "string" || v.viaConstructor === "undefined", v.viaConstructor);
  }

  {
    const result = await run(`
      let imported = "loaded";
      try { await import("fs"); } catch (e) { imported = "refused: " + e.message; }
      let child = "loaded";
      try { await import("node:child_process"); } catch (e) { child = "refused"; }
      return { imported, child };
    `);
    check("dynamic import of fs is refused", result.ok && /^refused/.test(result.value.imported), result.value ?? result.error);
    check("dynamic import of child_process is refused", result.ok && result.value.child === "refused", result.value ?? result.error);
  }

  {
    const result = await run(`import fs from "fs";\nreturn 1;`);
    check("a static import is a syntax error, not a file read", !result.ok && /SyntaxError|expecting/i.test(result.error), result.error);
  }

  // Determinism: nothing that differs between a run and its resume.
  {
    const result = await run(`
      const out = {};
      try { Math.random(); out.random = "allowed"; } catch (e) { out.random = e.message; }
      try { Date.now(); out.now = "allowed"; } catch (e) { out.now = e.message; }
      try { new Date(); out.newDate = "allowed"; } catch (e) { out.newDate = e.message; }
      try { Date(); out.callDate = "allowed"; } catch (e) { out.callDate = e.message; }
      const fixed = new Date("2026-01-02T03:04:05.000Z");
      out.iso = fixed.toISOString();
      out.isDate = fixed instanceof Date;
      out.parse = Date.parse("2026-01-02T03:04:05.000Z");
      out.utc = Date.UTC(2026, 0, 2);
      return out;
    `);
    const v = result.value ?? {};
    check("Math.random throws with guidance", /not available in workflows.*vary prompts by index/.test(v.random), v.random);
    check("Date.now throws with guidance", /Date\.now\(\) is not available/.test(v.now), v.now);
    check("argless new Date throws", /new Date\(\) without a value/.test(v.newDate), v.newDate);
    check("Date() as a call throws", /Date\(\) is not available/.test(v.callDate), v.callDate);
    check("new Date(iso) still works", v.iso === "2026-01-02T03:04:05.000Z", v.iso);
    check("instanceof Date holds for a fixed date", v.isDate === true);
    check("Date.parse works", v.parse === Date.parse("2026-01-02T03:04:05.000Z"));
    check("Date.UTC works", v.utc === Date.UTC(2026, 0, 2));
  }

  // Resource limits fail the script, not the host.
  {
    const started = Date.now();
    const result = await run(`let n = 0; while (true) { n += 1; }`, { limits: { busyMs: 400 } });
    check("a loop without await is stopped", !result.ok && /busy too long/.test(result.error), result.error);
    check("the busy stop is prompt", Date.now() - started < 8_000);
  }
  {
    const result = await run(`try { while (true) {} } catch (e) { return "caught"; }`, { limits: { busyMs: 300 } });
    check("the busy stop cannot be caught by the script", !result.ok && /busy too long/.test(result.error), result.value ?? result.error);
  }
  {
    const result = await run(`const keep = []; while (true) { keep.push(new Array(1e6).fill(1)); }`, { limits: { busyMs: 20_000 } });
    check("the heap limit fails the script", !result.ok && /memory/i.test(result.error), result.error);
  }
  {
    const result = await run(`function down(n) { return down(n + 1) + 1; } return down(0);`);
    check("unbounded recursion fails the script cleanly", !result.ok && /stack|overflow|RangeError/i.test(result.error), result.error);
  }
  {
    const result = await run(`return 41 + 1;`);
    check("the host keeps running scripts after a crashed one", result.ok && result.value === 42, result.error);
  }

  // Async shape: top-level await and return, values cross as JSON only.
  {
    const result = await run(
      `const first = await agent("count", { schema: { type: "object", properties: { n: { type: "number" } } } });\nreturn { next: first.n + 1, args };`,
      { args: { base: "main" }, agent: () => ({ ok: true, value: { n: 4 } }) },
    );
    check("top-level await and return work", result.ok && result.value.next === 5, result.value ?? result.error);
    check("args reach the script verbatim", result.ok && result.value.args.base === "main");
  }
  {
    const result = await run(
      `const value = await agent("x");\nreturn { type: typeof value, keys: Object.keys(value), proto: Object.getPrototypeOf(value) === Object.prototype };`,
      { agent: () => ({ ok: true, value: { a: 1 } }) },
    );
    check("an agent result is a plain guest object", result.ok && result.value.type === "object" && result.value.proto === true, result.value ?? result.error);
  }
  {
    const result = await run(`\n\nconst x = 1;\nthrow new Error("boom at four");\n`);
    check("errors name the line in the file", !result.ok && /boom at four/.test(result.error) && /line 4/.test(result.error), result.error);
  }
  {
    const parsed = metaMod.parseWorkflowSource(`// header\nexport const meta = {\n  name: "lines",\n  description: "d",\n};\n\nthrow new Error("seven");\n`);
    const result = await run(parsed.body);
    check("line numbers survive the blanked meta", !result.ok && /line 7/.test(result.error), result.error);
  }
  {
    const result = await run(`await new Promise(() => {}); return 1;`, { timeoutMs: 3_000 });
    check("a script waiting on nothing does not finish by itself", !result.ok && result.error === "test timeout");
  }
  {
    const result = await run(`const a = {}; a.self = a; return a;`);
    check("a cyclic return value is refused", !result.ok && /not plain JSON/.test(result.error), result.error);
  }
  {
    const result = await run(`await agent("x", { schema: () => 1 }); return 1;`, { agent: () => ({ ok: false, error: "never reached" }) });
    check("functions in opts are dropped at the JSON boundary", result.calls.length === 1 && result.calls[0].call.opts.schema === undefined, result.calls[0]?.call);
  }
  {
    const result = await run(`log("hello"); log({ a: 1 }); console.log("via", "console"); return 1;`);
    const logs = result.notes.filter((n) => n.op === "log").map((n) => n.value);
    check("log and console reach the host as text", JSON.stringify(logs) === JSON.stringify(["hello", '{"a":1}', "via console"]), logs);
  }

  // Everything posted to main is held there, so size and count are bounded
  // before it leaves the thread.
  {
    const result = await run(`try { await agent("x".repeat(300000)); return "sent"; } catch (e) { return e.message; }`);
    check("an oversized call never reaches main", result.calls.length === 0, result.calls.length);
    check("the script hears the size limit", result.ok && /KB; the limit is 256 KB/.test(result.value), result.value ?? result.error);
  }
  {
    const result = await run(
      `const ps = [];
       for (let i = 0; i < 10; i++) ps.push(agent("y".repeat(20000) + i).then(() => "ok", (e) => e.message));
       return await Promise.all(ps);`,
      {
        limits: { maxPendingCallBytes: 100_000 },
        agent: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: 1 }), 200)),
      },
    );
    const values = result.value ?? [];
    check("unanswered calls are capped by total size", result.calls.length === 4, result.calls.length);
    check(
      "calls past the pending cap throw in the script",
      values.filter((v) => v === "ok").length === 4 && values.filter((v) => /waiting for an answer/.test(v)).length === 6,
      values,
    );
  }
  {
    const result = await run(`for (let i = 0; i < 500; i++) log("n" + i); phase("late"); return 1;`, { limits: { maxNotes: 50 } });
    check("notes stop at the limit", result.ok && result.notes.length === 50, result.notes.length);
    check("the last note says the rest were dropped", /log limit reached/.test(result.notes.at(-1)?.value ?? ""), result.notes.at(-1));
  }
}

main()
  .catch((err) => {
    check("suite crashed", false, err && err.stack ? err.stack : String(err));
  })
  .finally(finish);
