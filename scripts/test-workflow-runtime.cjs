// Guards the workflow host runtime (src/main/orchestration/workflow-runtime.ts)
// with the journal and the real sandbox: caps the script cannot raise, one
// failing agent resolving null instead of failing the run, skip and stop,
// exact resume from the journal (zero agents for an unchanged finished run,
// the recorded completion order reproduced under concurrency, divergence at
// the first changed call), spend that survives Stop and Resume, and the
// guards against a script that awaits nothing, retries refused calls forever
// or floods main with notes.
//
//   node scripts/test-workflow-runtime.cjs

const { bundleModule, loadSandboxWorkerCode, check, finish } = require("./workflow-test-harness.cjs");

let runtimeMod;
let journalMod;
let sandboxMod;
let admissionMod;

const CAPS = { concurrency: 4, maxAgents: 200, tokenCeiling: null, usdCeiling: null };
const DEFAULTS = { model: "test-model", effort: "medium" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Agents answer from their prompt: "fail:" throws inside the executor,
// "null:" ends without a result, "delay=N" waits N ms, "tokens=N" reports
// usage. Everything else echoes the prompt.
function fakeExecutor(log = {}) {
  log.runs = log.runs ?? [];
  log.maxLive = log.maxLive ?? 0;
  let live = 0;
  return {
    log,
    async run(request, control) {
      log.runs.push(request);
      live += 1;
      log.maxLive = Math.max(log.maxLive, live);
      try {
        control.started({ workerTaskId: `task-${request.seq}`, attemptId: `att-${request.seq}` });
        const delay = Number(/delay=(\d+)/.exec(request.prompt)?.[1] ?? 5);
        const tokens = Number(/tokens=(\d+)/.exec(request.prompt)?.[1] ?? 10);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delay);
          control.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        const usage = { in: tokens, out: 0, usd: tokens / 1000 };
        if (control.signal.aborted) return { status: "null", usage, note: "stopped" };
        if (request.prompt.startsWith("fail:")) throw new Error("worker crashed");
        if (request.prompt.startsWith("null:")) return { status: "null", usage, note: "worker ended failed" };
        if (request.schema) return { status: "ok", value: { answer: request.prompt }, usage };
        return { status: "ok", value: `echo ${request.prompt}`, usage };
      } finally {
        live -= 1;
      }
    },
  };
}

function memoryJournal() {
  const entries = [];
  const results = new Map();
  return {
    entries,
    append(entry) {
      entries.push(JSON.parse(JSON.stringify(entry)));
    },
    saveResult(seq, value) {
      const ref = `results/${seq}.json`;
      results.set(ref, JSON.stringify(value));
      return ref;
    },
    loadResult(ref) {
      return JSON.parse(results.get(ref));
    },
  };
}

async function runScript(body, options = {}) {
  const executor = options.executor ?? fakeExecutor();
  const journal = options.journal ?? memoryJournal();
  const runtime = new runtimeMod.WorkflowRuntime({
    runId: "run-test",
    body,
    args: options.args ?? null,
    caps: { ...CAPS, ...options.caps },
    defaults: DEFAULTS,
    phases: options.phases,
    checkModel: options.checkModel,
    executor,
    admission: options.admission,
    journal,
    replay: options.replay,
    generation: options.replay ? 1 : 0,
    sandboxLimits: options.limits,
    startSandbox: sandboxMod.startWorkflowSandbox,
  });
  const started = runtime.start();
  if (options.during) await options.during(runtime);
  const outcome = await Promise.race([
    started,
    sleep(options.timeoutMs ?? 20_000).then(() => ({ status: "timeout" })),
  ]);
  if (outcome.status === "timeout") await runtime.stop();
  return { outcome, runtime, executor, journal };
}

async function main() {
  runtimeMod = await bundleModule("workflow-runtime.ts");
  journalMod = await bundleModule("workflow-journal.ts");
  admissionMod = await bundleModule("workflow-admission.ts");
  // The runtime bundle carries its own copy of the sandbox module, so the
  // suite hands it a sandbox starter that runs the bundled worker.
  sandboxMod = await bundleModule("workflow-sandbox.ts");
  sandboxMod.setWorkflowSandboxWorkerCode(await loadSandboxWorkerCode());

  // ── Basics and failure isolation ─────────────────────────────────────────
  {
    const { outcome, executor } = await runScript(`
      phase("Find");
      const found = await parallel([
        () => agent("one"),
        () => agent("fail: two"),
        () => agent("null: three"),
        () => agent("four", { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }),
      ]);
      return found;
    `);
    check("a script with a failing agent still completes", outcome.status === "complete", outcome);
    const value = outcome.value ?? [];
    check("a successful agent resolves to its text", value[0] === "echo one", value);
    check("an executor crash resolves that agent to null", value[1] === null, value);
    check("a worker that ends without a result resolves null", value[2] === null, value);
    check("a schema agent resolves to its result object", value[3] && value[3].answer === "four", value);
    check("all four agents ran", executor.log.runs.length === 4);
    check("agents carry the phase they were issued in", executor.log.runs.every((r) => r.phase === "Find"));
    check("omitted model and effort take the run defaults", executor.log.runs.every((r) => r.model === "test-model" && r.effort === "medium"));
  }
  {
    const { outcome, executor } = await runScript(`
      let threw = "no";
      try { await agent("x", { schema: { type: "array" } }); } catch (e) { threw = e.message; }
      let bad = "no";
      try { await agent("y", { effort: "turbo" }); } catch (e) { bad = e.message; }
      let model = "no";
      try { await agent("z", { model: "gone-model" }); } catch (e) { model = e.message; }
      return { threw, bad, model };
    `, { checkModel: (m) => (m === "gone-model" ? "model gone-model is not connected" : null) });
    check("an invalid schema throws in the script", /schema root must be/.test(outcome.value?.threw), outcome);
    check("an unknown effort throws", /effort must be one of/.test(outcome.value?.bad), outcome.value);
    check("a disconnected model throws", /not connected/.test(outcome.value?.model), outcome.value);
    check("invalid calls never reach an executor", executor.log.runs.length === 0);
  }
  {
    const { outcome } = await runScript(`throw new Error("script bug");`);
    check("a throwing script fails the run with its message", outcome.status === "failed" && /script bug/.test(outcome.error), outcome);
  }

  // ── Caps ─────────────────────────────────────────────────────────────────
  {
    const { outcome, executor } = await runScript(
      `return await parallel(Array.from({ length: 12 }, (_, i) => () => agent("delay=30 item " + i)));`,
      { caps: { concurrency: 3 } },
    );
    check("parallel fan-out completes", outcome.status === "complete" && outcome.value.length === 12, outcome);
    check("never more than the concurrency cap run at once", executor.log.maxLive === 3, executor.log.maxLive);
  }
  {
    const { outcome, executor } = await runScript(
      `const r = await parallel(Array.from({ length: 5 }, (_, i) => () => agent("cap " + i)));
       let late = "none";
       try { await agent("one more"); } catch (e) { late = e.message; }
       return { r, late };`,
      { caps: { maxAgents: 3 } },
    );
    check("maxAgents: only the first agents run", executor.log.runs.length === 3, executor.log.runs.length);
    check("maxAgents: the excess resolve null inside parallel", outcome.value?.r.filter((v) => v === null).length === 2, outcome.value);
    check("maxAgents: a direct call past the cap throws", /maxAgents reached/.test(outcome.value?.late), outcome.value);
  }
  {
    const { outcome, executor } = await runScript(
      `const out = [];
       for (let i = 0; i < 10; i += 1) {
         try { out.push(await agent("tokens=40 step " + i)); } catch (e) { out.push("stop: " + e.message); break; }
       }
       return { out, spent: budget.spent(), total: budget.total };`,
      { caps: { tokenCeiling: 100 } },
    );
    check("token ceiling: agents stop once spent reaches the ceiling", executor.log.runs.length === 3, executor.log.runs.length);
    check("token ceiling: the next call throws", /token ceiling reached/.test(outcome.value?.out.at(-1)), outcome.value);
    check("budget.spent() sees the delivered usage", outcome.value?.spent === 120, outcome.value);
    check("budget.total exposes the ceiling", outcome.value?.total === 100);
  }
  {
    const admission = new admissionMod.WorkflowAdmission({ machineSlots: 2, heavySlots: 1 });
    const executor = fakeExecutor();
    const [a, b] = await Promise.all([
      runScript(`return await parallel([1,2,3,4].map((i) => () => agent("delay=40 a" + i)));`, { admission, executor }),
      runScript(`return await parallel([1,2,3,4].map((i) => () => agent("delay=40 b" + i)));`, { admission, executor }),
    ]);
    check("two runs share the machine-wide slots", executor.log.maxLive === 2, executor.log.maxLive);
    check("both runs complete under the shared pool", a.outcome.status === "complete" && b.outcome.status === "complete");
  }

  // ── Skip and stop ────────────────────────────────────────────────────────
  {
    const { outcome } = await runScript(
      `return await parallel([() => agent("delay=4000 slow"), () => agent("fast")]);`,
      {
        async during(runtime) {
          await sleep(300);
          check("skip finds the live call", runtime.skip(0) === true);
        },
      },
    );
    check("a skipped agent resolves null and the run goes on", outcome.status === "complete" && outcome.value[0] === null && outcome.value[1] === "echo fast", outcome);
  }
  {
    const journal = memoryJournal();
    let runtimeRef;
    const { outcome } = await runScript(
      `const a = await agent("first");
       const b = await agent("delay=5000 second");
       return [a, b];`,
      {
        journal,
        async during(runtime) {
          runtimeRef = runtime;
          await sleep(400);
          await runtime.stop();
        },
      },
    );
    check("stop ends the run as stopped", outcome.status === "stopped", outcome);
    const dones = journal.entries.filter((e) => e.t === "done");
    check("stop journals only the finished agent", dones.length === 1 && dones[0].seq === 0, dones);
    check("the stopped agent shows as queued for a rerun", runtimeRef.snapshot().phases[0].calls[1].status === "queued");

    // Resume: the finished agent is cached, the stopped one runs again.
    const executor = fakeExecutor();
    const resumed = await runScript(
      `const a = await agent("first");
       const b = await agent("delay=5 second");
       return [a, b];`,
      { replay: journal.entries, executor },
    );
    check("resume completes", resumed.outcome.status === "complete", resumed.outcome);
    check("resume reuses the finished agent", resumed.outcome.value?.[0] === "echo first");
    check("resume runs only the agent that had not finished", executor.log.runs.length === 1 && executor.log.runs[0].prompt === "delay=5 second", executor.log.runs.map((r) => r.prompt));
  }
  {
    // The unchanged script: the stopped call is the journal's last entry, an
    // issue with no result, and must still run once the replay runs out.
    const body = `const a = await agent("first");
       const b = await agent("delay=1500 second");
       return [a, b];`;
    const journal = memoryJournal();
    await runScript(body, {
      journal,
      async during(runtime) {
        await sleep(400);
        await runtime.stop();
      },
    });
    const executor = fakeExecutor();
    const resumed = await runScript(body, { replay: journal.entries, executor });
    check("resume of an unchanged script completes", resumed.outcome.status === "complete", resumed.outcome);
    check("the call stopped last runs again", executor.log.runs.length === 1 && executor.log.runs[0].prompt === "delay=1500 second", executor.log.runs.map((r) => r.prompt));
  }

  {
    // What a stopped agent used is part of the run's spend, before and after
    // a resume, and so is a recorded result an edited script can no longer use.
    const body = `const a = await agent("tokens=100 first");
       const b = await agent("delay=5000 tokens=40 second");
       return [a, b];`;
    const journal = memoryJournal();
    let runtimeRef;
    await runScript(body, {
      journal,
      async during(runtime) {
        runtimeRef = runtime;
        await sleep(400);
        await runtime.stop();
      },
    });
    const stopped = runtimeRef.spent;
    check("a stopped agent's usage stays in the run's spend", stopped.inputTokens === 140, stopped);
    check("the stopped row shows what it used", runtimeRef.snapshot().phases[0].calls[1].tokens === 40);
    check("the stopped agent's usage is journaled", journal.entries.some((e) => e.t === "abandoned" && e.usage.in === 40), journal.entries);
    const executor = fakeExecutor();
    const second = memoryJournal();
    const resumed = await runScript(body.replace("delay=5000", "delay=5"), { replay: journal.entries, executor, journal: second });
    check(
      "a resumed run counts the earlier stopped agent too",
      resumed.outcome.status === "complete" && resumed.runtime.spent.inputTokens === 180,
      resumed.runtime.spent,
    );
    check("the new generation carries the abandoned usage forward", second.entries.some((e) => e.t === "abandoned" && e.usage.in === 40));
    const edited = await runScript(`return await agent("tokens=7 other");`, { replay: second.entries, executor: fakeExecutor() });
    check(
      "results an edited script cannot reuse still count",
      edited.outcome.status === "complete" && edited.runtime.spent.inputTokens === 187,
      edited.runtime.spent,
    );
  }

  // ── Determinism and caching ──────────────────────────────────────────────
  const RACE = `
    const order = [];
    const results = await parallel([
      () => agent("delay=120 slow").then((v) => { order.push("slow"); return v; }),
      () => agent("delay=10 fast").then((v) => { order.push("fast"); return v; }),
    ]);
    // Branch on which came first: a replay must take the same branch.
    const next = await agent("winner was " + order[0]);
    return { order, next };
  `;
  {
    const journal = memoryJournal();
    const first = await runScript(RACE, { journal });
    check("the race script completes", first.outcome.status === "complete" && first.outcome.value.order[0] === "fast", first.outcome);
    check("the journal starts with a start entry", journal.entries[0].t === "start");

    const executor = fakeExecutor();
    const replayed = await runScript(RACE, { replay: journal.entries, executor });
    check("an unchanged finished run replays with zero agents", executor.log.runs.length === 0, executor.log.runs.map((r) => r.prompt));
    check("the replay reproduces the recorded completion order", JSON.stringify(replayed.outcome.value) === JSON.stringify(first.outcome.value), replayed.outcome.value);
    check("every replayed call is marked cached", replayed.runtime.counts.cached === 3, replayed.runtime.counts);
    check("a fully cached replay never diverges", replayed.runtime.diverged === null);

    // Editing only the last prompt keeps the two racing calls cached.
    const edited = RACE.replace('"winner was "', '"the winner was "');
    const executor2 = fakeExecutor();
    const diverged = await runScript(edited, { replay: journal.entries, executor: executor2 });
    check("an edited later prompt reruns only that call", executor2.log.runs.length === 1 && /the winner was fast/.test(executor2.log.runs[0].prompt), executor2.log.runs.map((r) => r.prompt));
    check("divergence is recorded at the edited call", diverged.runtime.diverged === 2, diverged.runtime.diverged);
  }
  {
    const base = `
      phase("A");
      const a = await agent("alpha", { label: "first label" });
      const b = await agent("beta");
      return [a, b];
    `;
    const journal = memoryJournal();
    await runScript(base, { journal });
    const relabeled = base.replace('"first label"', '"renamed"').replace('phase("A")', 'phase("Renamed phase")');
    const executor = fakeExecutor();
    const again = await runScript(relabeled, { replay: journal.entries, executor });
    check("label and phase edits keep the cache", executor.log.runs.length === 0 && again.outcome.status === "complete", executor.log.runs.map((r) => r.prompt));

    const editedFirst = base.replace('"alpha"', '"alpha v2"');
    const executor2 = fakeExecutor();
    await runScript(editedFirst, { replay: journal.entries, executor: executor2 });
    check("a changed first prompt reruns it and everything after", executor2.log.runs.length === 2, executor2.log.runs.map((r) => r.prompt));
  }
  {
    // Identical prompts get distinct #n keys, so each keeps its own result.
    const script = `return await parallel([1, 2, 3].map(() => () => agent("same prompt")));`;
    const journal = memoryJournal();
    await runScript(script, { journal });
    const keys = journal.entries.filter((e) => e.t === "issue").map((e) => e.key);
    check("repeated prompts get #0, #1, #2 keys", keys.length === 3 && keys[0].endsWith("#0") && keys[2].endsWith("#2"), keys);
    const executor = fakeExecutor();
    await runScript(script, { replay: journal.entries, executor });
    check("repeated prompts all replay from cache", executor.log.runs.length === 0);
  }
  {
    // A thrown answer (maxAgents) is asked again on resume with a higher cap.
    const script = `return await parallel([1, 2, 3].map((i) => () => agent("capped " + i)));`;
    const journal = memoryJournal();
    const first = await runScript(script, { journal, caps: { maxAgents: 2 } });
    check("the capped run resolves one null", first.outcome.value.filter((v) => v === null).length === 1, first.outcome.value);
    const executor = fakeExecutor();
    const raised = await runScript(script, { journal: memoryJournal(), replay: journal.entries, executor, caps: { maxAgents: 10 } });
    check("resume with a raised cap runs only the refused call", executor.log.runs.length === 1, executor.log.runs.map((r) => r.prompt));
    check("resume with a raised cap fills the gap", raised.outcome.value.every((v) => typeof v === "string"), raised.outcome.value);
  }
  {
    // Large results go to a side file and come back on replay.
    const script = `const r = await agent("big", { schema: { type: "object", properties: { answer: { type: "string" } } } }); return r.answer.length;`;
    const journal = memoryJournal();
    const bigExecutor = {
      async run() {
        return { status: "ok", value: { answer: "x".repeat(40_000) }, usage: { in: 1, out: 1, usd: 0 } };
      },
    };
    const first = await runScript(script, { journal, executor: bigExecutor });
    const done = journal.entries.find((e) => e.t === "done");
    check("a large result is stored by reference", done && done.resultRef && done.result === undefined, done);
    const executor = fakeExecutor();
    const again = await runScript(script, { journal: { ...memoryJournal(), loadResult: journal.loadResult }, replay: journal.entries, executor });
    check("a stored result replays from its file", again.outcome.value === 40_000 && first.outcome.value === 40_000 && executor.log.runs.length === 0, again.outcome);
  }
  {
    const tooBig = {
      async run() {
        return { status: "ok", value: { answer: "x".repeat(600 * 1024) }, usage: { in: 1, out: 1, usd: 0 } };
      },
    };
    const { outcome } = await runScript(`return await agent("huge", { schema: { type: "object", properties: { answer: { type: "string" } } } });`, { executor: tooBig });
    check("a result over the size limit resolves null", outcome.status === "complete" && outcome.value === null, outcome);
  }

  // ── Scripts that can never finish ────────────────────────────────────────
  {
    const { outcome } = await runScript(`await new Promise(() => {}); return 1;`, { timeoutMs: 5_000 });
    check("a script awaiting nothing fails instead of hanging", outcome.status === "failed" && /can never settle/.test(outcome.error), outcome);
  }
  {
    const { outcome } = await runScript(`await agent("x"); await new Promise(() => {}); return 1;`, { timeoutMs: 5_000 });
    check("the deadlock guard also fires after agents ran", outcome.status === "failed" && /can never settle/.test(outcome.error), outcome);
  }

  {
    // A refusal answers at once, so catching it in a loop never yields to
    // anything that could end the run.
    const { outcome } = await runScript(`for (;;) { try { await agent("x"); } catch (e) {} }`, {
      caps: { maxAgents: 1 },
      timeoutMs: 15_000,
    });
    check("a script retrying refused calls forever fails", outcome.status === "failed" && /calls were refused/.test(outcome.error), outcome);
  }
  {
    const { outcome } = await runScript(`for (;;) { try { await agent("x", { effort: "huge" }); } catch (e) {} }`, { timeoutMs: 15_000 });
    check("so does one retrying an invalid call forever", outcome.status === "failed" && /calls were refused/.test(outcome.error), outcome);
  }
  {
    // A burst of phase() titles used to cost a linear scan each on main.
    const journal = memoryJournal();
    const started = Date.now();
    const { outcome } = await runScript(`for (let i = 0; ; i++) phase("p" + i);`, { journal, limits: { busyMs: 1_500 }, timeoutMs: 15_000 });
    check("a phase() flood ends as a busy script", outcome.status === "failed" && /busy too long/.test(outcome.error), outcome);
    check("main heard at most the note limit", journal.entries.filter((e) => e.t === "phase").length < 10_000, journal.entries.length);
    check("main stayed responsive", Date.now() - started < 8_000, Date.now() - started);
  }

  // ── The journal on disk ──────────────────────────────────────────────────
  {
    const parsed = journalMod.parseJournal(`{"t":"start","runtime":1}\n{"t":"issue","seq":0,"key":"k#0"}\n{"t":"do`);
    check("a torn last line is dropped", parsed.length === 2);
    const fs = require("node:fs");
    const path = require("node:path");
    const { tempDir } = require("./workflow-test-harness.cjs");
    const dir = path.join(tempDir(), "journal-files");
    fs.mkdirSync(dir, { recursive: true });
    const writer0 = new journalMod.JournalWriter(path.join(dir, journalMod.journalFileName(0)));
    await writer0.append({ t: "start", runtime: 1, scriptHash: "s", argsHash: "a", defaults: DEFAULTS, generation: 0 });
    await writer0.append({ t: "issue", seq: 0, key: "k#0", label: "l", phase: "p" });
    await writer0.close();
    const writer1 = new journalMod.JournalWriter(path.join(dir, journalMod.journalFileName(1)));
    await writer1.append({ t: "start", runtime: 1, scriptHash: "s", argsHash: "a", defaults: DEFAULTS, generation: 1 });
    await writer1.close();
    let source = await journalMod.latestReplaySource(dir);
    check("a resume whose replay never finished leaves the older generation in charge", source && source.generation === 0, source);
    const writer1b = new journalMod.JournalWriter(path.join(dir, journalMod.journalFileName(1)));
    await writer1b.append({ t: "live", divergedAtSeq: null });
    await writer1b.close();
    source = await journalMod.latestReplaySource(dir);
    check("a generation becomes the source once its replay finished", source && source.generation === 1, source);
  }
}

main()
  .catch((err) => {
    check("suite crashed", false, err && err.stack ? err.stack : String(err));
  })
  .finally(finish);
