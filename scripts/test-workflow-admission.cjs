// Guards machine-wide workflow admission
// (src/main/orchestration/workflow-admission.ts): the slot pool shared by
// every workflow run, the heavy-work semaphore and the memory gate that holds
// new launches when the machine runs short, which keep many parallel agents
// from freezing the desktop.
//
//   node scripts/test-workflow-admission.cjs

const { bundleModule, check, finish } = require("./workflow-test-harness.cjs");

const GB = 1024 * 1024 * 1024;

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const { WorkflowAdmission, defaultReserveBytes } = await bundleModule("workflow-admission.ts");

  {
    const admission = new WorkflowAdmission({ machineSlots: 2, heavySlots: 1 });
    const granted = [];
    const waits = {};
    const tickets = ["a1", "b1", "a2", "b2"].map((id) =>
      admission.request({ runId: id[0], heavy: false, onWait: (reason) => (waits[id] = reason) }),
    );
    tickets.forEach((ticket, i) => ticket.granted.then((lease) => granted.push([i, lease])));
    await tick();
    check("the pool grants only its slot count across runs", granted.length === 2, granted.length);
    check("waiters say they wait for a machine slot", waits.a2 === "machine" && waits.b2 === "machine", waits);
    granted[0][1].release();
    await tick();
    check("a release admits the next waiter in order", granted.length === 3 && granted[2][0] === 2, granted.map((g) => g[0]));
    tickets[3].cancel();
    granted[1][1].release();
    await tick();
    check("a cancelled waiter is never granted", granted.length === 3);
    granted[2][1].release();
    check("the pool empties", admission.usage.active === 0, admission.usage);
  }
  {
    const admission = new WorkflowAdmission({ machineSlots: 4, heavySlots: 1 });
    const got = [];
    const waits = {};
    const heavy1 = admission.request({ runId: "r", heavy: true });
    const heavy2 = admission.request({ runId: "r", heavy: true, onWait: (reason) => (waits.heavy2 = reason) });
    const light = admission.request({ runId: "r", heavy: false });
    heavy1.granted.then((lease) => got.push(["heavy1", lease]));
    heavy2.granted.then((lease) => got.push(["heavy2", lease]));
    light.granted.then((lease) => got.push(["light", lease]));
    await tick();
    check("one heavy slot admits one heavy agent", got.some((g) => g[0] === "heavy1") && !got.some((g) => g[0] === "heavy2"), got.map((g) => g[0]));
    check("a heavy waiter does not block ordinary agents", got.some((g) => g[0] === "light"));
    check("the heavy waiter says why", waits.heavy2 === "heavy");
    got.find((g) => g[0] === "heavy1")[1].release();
    await tick();
    check("releasing the heavy slot admits the next heavy agent", got.some((g) => g[0] === "heavy2"));
  }
  {
    let available = 10 * GB;
    let swap = 0;
    let fire = null;
    const admission = new WorkflowAdmission({
      machineSlots: 6,
      heavySlots: 1,
      sampleMemory: () => ({ totalBytes: 32 * GB, availableBytes: available, swapUsedBytes: swap }),
      setTimer: (fn) => {
        fire = fn;
        return () => (fire = null);
      },
    });
    check("the default reserve is the larger of 4 GB and 15 percent", defaultReserveBytes(32 * GB) === Math.floor(32 * GB * 0.15) && defaultReserveBytes(8 * GB) === 4 * GB);
    const got = [];
    const waits = {};
    const first = admission.request({ runId: "r", heavy: false });
    first.granted.then((lease) => got.push(lease));
    await tick();
    available = 2 * GB;
    const second = admission.request({ runId: "r", heavy: false, onWait: (reason) => (waits.second = reason) });
    second.granted.then((lease) => got.push(lease));
    await tick();
    check("low memory holds new launches", got.length === 1 && waits.second === "memory", { got: got.length, waits });
    check("the gate reports the reading that holds it", admission.memoryWait && admission.memoryWait.freeBytes === 2 * GB);
    check("a recheck is scheduled", typeof fire === "function");
    available = 12 * GB;
    fire();
    await tick();
    check("the gate reopens when memory comes back", got.length === 2 && admission.memoryWait === null);

    swap = 1 * GB;
    const third = admission.request({ runId: "r", heavy: false, onWait: (reason) => (waits.third = reason) });
    third.granted.then((lease) => got.push(lease));
    await tick();
    check("swap growth since the pool went busy holds launches", got.length === 2 && waits.third === "memory", waits);
    got.forEach((lease) => lease.release());
    await tick();
    check("with nothing of ours running the first agent always goes", got.length === 3);
    admission.dispose();
  }
  {
    const admission = new WorkflowAdmission({ machineSlots: 1, heavySlots: 1 });
    const got = [];
    admission.request({ runId: "r", heavy: false }).granted.then((lease) => got.push(lease));
    admission.request({ runId: "r", heavy: false }).granted.then((lease) => got.push(lease));
    await tick();
    admission.configure({ machineSlots: 2 });
    await tick();
    check("raising the slot count admits waiters at once", got.length === 2);
  }
}

main()
  .catch((err) => {
    check("suite crashed", false, err && err.stack ? err.stack : String(err));
  })
  .finally(finish);
