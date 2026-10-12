// Guards the workflow script API (src/main/orchestration/workflow-prelude.ts)
// as the guest sees it inside the real sandbox: parallel() never rejects,
// pipeline() has no barrier between stages, phase() and opts.phase group
// calls, and nested workflow() runs one level deep.
//
//   node scripts/test-workflow-prelude.cjs

const { bundleModule, loadSandboxWorkerCode, check, finish } = require("./workflow-test-harness.cjs");

let sandboxMod;

// Answers each agent call after the delay named in its prompt ("d=N"), so a
// test controls the order results come back in.
function run(body, options = {}) {
  return new Promise((resolve) => {
    const calls = [];
    const notes = [];
    const events = [];
    let sandbox;
    const timer = setTimeout(() => {
      void sandbox.terminate();
      resolve({ ok: false, error: "test timeout", calls, notes, events });
    }, 20_000);
    sandbox = sandboxMod.startWorkflowSandbox({
      body,
      args: options.args ?? null,
      children: options.children,
      handlers: {
        onCall(id, ctx, call) {
          calls.push({ id, ctx, call });
          events.push(`issue ${call.prompt}`);
          const delay = Number(/d=(\d+)/.exec(call.prompt)?.[1] ?? 0);
          setTimeout(() => {
            events.push(`done ${call.prompt}`);
            if (/throw/.test(call.prompt)) sandbox.reply(id, { ok: false, error: "agent refused" });
            else sandbox.reply(id, { ok: true, value: call.prompt, usage: { tokens: 5, usd: 0 } });
          }, delay);
        },
        onNote(ctx, op, value) {
          notes.push({ ctx, op, value });
        },
        onChild() {},
        onIdle() {},
        onDone(result) {
          clearTimeout(timer);
          resolve({ ...result, calls, notes, events });
        },
      },
    });
  });
}

async function main() {
  sandboxMod = await bundleModule("workflow-sandbox.ts");
  sandboxMod.setWorkflowSandboxWorkerCode(await loadSandboxWorkerCode());

  {
    const result = await run(`
      return await parallel([
        () => agent("a"),
        () => { throw new Error("sync throw"); },
        () => agent("throw please"),
        "not a function",
      ]);
    `);
    check("parallel resolves", result.ok, result.error);
    check("parallel maps a sync throw to null", result.value[1] === null, result.value);
    check("parallel maps a rejected agent to null", result.value[2] === null, result.value);
    check("parallel passes plain values through", result.value[3] === "not a function", result.value);
    check("parallel logs why an item became null", result.notes.some((n) => /parallel item 1 resolved null: sync throw/.test(n.value)), result.notes);
  }
  {
    const result = await run(`return await parallel(Array.from({ length: 4097 }, () => () => 1));`);
    check("parallel refuses more than 4096 items", !result.ok && /at most 4096/.test(result.error), result.error);
  }
  {
    // Item A is quick in stage 1, item B slow: without a barrier A reaches
    // stage 2 before B leaves stage 1.
    const result = await run(`
      return await pipeline(["A", "B"],
        (prev, item) => agent("s1 " + item + (item === "A" ? " d=10" : " d=300")),
        (prev, item) => agent("s2 " + item + " d=10"),
      );
    `);
    check("pipeline resolves every item", result.ok && result.value.length === 2, result.error);
    const a2 = result.events.indexOf("issue s2 A d=10");
    const b1done = result.events.indexOf("done s1 B d=300");
    check("pipeline has no barrier between stages", a2 >= 0 && b1done >= 0 && a2 < b1done, result.events);
  }
  {
    const result = await run(`
      return await pipeline([1, 2, 3],
        (prev, item) => { if (item === 2) throw new Error("drop two"); return agent("first " + item); },
        (prev, item, index) => agent("second " + index + " after " + prev),
      );
    `);
    check("a throwing stage drops only that item", result.ok && result.value[1] === null && result.value[0] && result.value[2], result.value);
    check("a dropped item skips its later stages", !result.calls.some((c) => /second 1/.test(c.call.prompt)), result.calls.map((c) => c.call.prompt));
    check("stages get (prev, item, index)", result.calls.some((c) => c.call.prompt === "second 2 after first 3"), result.calls.map((c) => c.call.prompt));
  }
  {
    const result = await run(`
      phase("Find");
      await agent("in find");
      await parallel([
        () => agent("explicit", { phase: "Verify" }),
        () => agent("implicit"),
      ]);
      return 1;
    `);
    const phaseOf = (prompt) => result.calls.find((c) => c.call.prompt === prompt)?.call.phase;
    check("phase() sets the group of later calls", phaseOf("in find") === "Find");
    check("opts.phase beats the current phase", phaseOf("explicit") === "Verify");
    check("calls without opts.phase keep the current phase", phaseOf("implicit") === "Find");
    check("phase() is reported to the host", result.notes.some((n) => n.op === "phase" && n.value === "Find"));
  }
  {
    const children = {
      inner: {
        name: "inner",
        body: `phase("Check"); const r = await agent("inner sees " + args.topic); let deeper = "allowed"; try { await workflow("inner"); } catch (e) { deeper = e.message; } return { r, deeper };`,
      },
    };
    const result = await run(`
      const out = await workflow("inner", { topic: "auth" });
      let missing = "found";
      try { await workflow("nope"); } catch (e) { missing = e.message; }
      return { out, missing };
    `, { children });
    check("a nested workflow returns its value", result.ok && result.value.out.r === "inner sees auth", result.value ?? result.error);
    check("a nested workflow's phases carry its name", result.calls[0]?.call.phase === "> inner: Check", result.calls[0]?.call);
    check("nested calls name their workflow", result.calls[0]?.ctx === "inner");
    check("nesting stops at one level", /one level deep/.test(result.value?.out.deeper), result.value?.out);
    check("an unknown nested workflow throws", /no saved workflow named "nope"/.test(result.value?.missing), result.value);
  }
  {
    const result = await run(`
      const before = budget.spent();
      await agent("one");
      await agent("two");
      return { before, after: budget.spent(), remaining: budget.remaining(), frozen: Object.isFrozen(budget) };
    `);
    check("budget.spent() advances with delivered usage", result.ok && result.value.before === 0 && result.value.after === 10, result.value);
    check("budget.remaining() is Infinity without a ceiling", result.value?.remaining === null || result.value?.remaining === Infinity, result.value);
    check("budget cannot be replaced", result.value?.frozen === true);
  }
}

main()
  .catch((err) => {
    check("suite crashed", false, err && err.stack ? err.stack : String(err));
  })
  .finally(finish);
