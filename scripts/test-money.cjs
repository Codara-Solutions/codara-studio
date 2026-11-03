// Euro display of Automations money: the conversion, the ECB parse, the rate
// cache and its fallbacks, and a cap going euros -> stored dollars -> euros.
//
//   node scripts/test-money.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-"));
  const entry = path.join(dir, "entry.ts");
  fs.writeFileSync(
    entry,
    `export * from ${JSON.stringify(path.join(ROOT, "src/shared/money.ts"))};\n` +
      `export * from ${JSON.stringify(path.join(ROOT, "src/main/fx-rate.ts"))};\n` +
      `export { guardDraftProblem } from ${JSON.stringify(path.join(ROOT, "src/shared/automation-guard.ts"))};\n` +
      `export { draftFromJob, buildGuard, buildLoop } from ${JSON.stringify(path.join(ROOT, "src/renderer/src/components/automations/flow/model.ts"))};\n` +
      `export * from ${JSON.stringify(path.join(ROOT, "src/renderer/src/components/automations/flow/sentence-model.ts"))};\n`,
  );
  const out = path.join(ROOT, "node_modules", ".cache", `money-${process.pid}.cjs`);
  esbuild.buildSync({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    alias: { "@shared": path.join(ROOT, "src/shared") },
    logLevel: "silent",
  });
  const mod = require(out);
  fs.rmSync(out, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

const m = load();
const R = { usdPerEur: 1.25, date: "2026-11-02", source: "ecb" };

(async () => {
  // Conversion and format.
  assert.equal(m.fmtMoney(2, { rate: R }), "≈€1.60 ($2.00)");
  assert.equal(m.fmtMoney(2, { rate: R, approx: false }), "€1.60 ($2.00)");
  assert.equal(m.fmtMoney(undefined, { rate: R }), "≈€0.00 ($0.00)");
  assert.equal(m.fmtMoney(Number.NaN, { rate: R }), "≈€0.00 ($0.00)");
  assert.equal(m.eurToUsd(2, R), 2.5);
  assert.match(m.rateNote(R), /1 € = \$1\.2500 \(ECB rate of 2026-11-02\)/);
  assert.deepEqual("a ≈€1.60 ($2.00) b".match(m.MONEY_USD_PART), ["($2.00)"]);

  // ECB XML.
  const xml = `<gesmes:Envelope><Cube><Cube time='2026-11-02'><Cube currency='USD' rate='1.1216'/><Cube currency='JPY' rate='170.1'/></Cube></Cube></gesmes:Envelope>`;
  assert.deepEqual(m.parseEcbDaily(xml), { usdPerEur: 1.1216, date: "2026-11-02", source: "ecb" });
  assert.equal(m.parseEcbDaily("<html>nope</html>"), null);
  assert.equal(m.parseEcbDaily(xml.replace("1.1216", "0")), null, "a zero rate is junk");
  assert.equal(m.parseEcbDaily(xml.replace("1.1216", "99")), null, "so is an absurd one");
  assert.equal(m.BUILT_IN_RATE.source, "built-in");

  // The cache: one request a day, then the last cached rate, then the constant.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-cache-"));
  try {
    delete process.env.CODARA_FX_RATE;
    let calls = 0;
    const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
    const okFetch = async (url) => {
      calls += 1;
      assert.equal(url, "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
      return xml;
    };
    const failing = async () => {
      calls += 1;
      throw new Error("offline");
    };

    assert.equal((await m.loadFxRate({ dir, now: () => T0, fetchText: failing })).source, "built-in", "nothing cached, offline: the constant");
    assert.equal(calls, 1);

    const first = await m.loadFxRate({ dir, now: () => T0, fetchText: okFetch });
    assert.deepEqual(first, { usdPerEur: 1.1216, date: "2026-11-02", source: "ecb" });
    assert.equal(calls, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "fx-rate.json"), "utf8")).usdPerEur, 1.1216);

    const again = await m.loadFxRate({ dir, now: () => T0 + 3_600_000, fetchText: failing });
    assert.equal(calls, 2, "a fresh cache is not fetched again within the day");
    assert.deepEqual(again, { usdPerEur: 1.1216, date: "2026-11-02", source: "cache" });

    const stale = await m.loadFxRate({ dir, now: () => T0 + 25 * 3_600_000, fetchText: failing });
    assert.equal(calls, 3, "after a day it asks again");
    assert.deepEqual(stale, { usdPerEur: 1.1216, date: "2026-11-02", source: "cache" }, "and falls back to the last cached rate when it fails");

    const junk = await m.loadFxRate({ dir, now: () => T0 + 25 * 3_600_000, fetchText: async () => "<html>captive portal</html>" });
    assert.equal(junk.source, "cache", "an unreadable answer keeps the cached rate");

    const fresher = xml.replace("2026-11-02", "2026-11-04").replace("1.1216", "1.15");
    const next = await m.loadFxRate({ dir, now: () => T0 + 25 * 3_600_000, fetchText: async () => fresher });
    assert.equal(next.usdPerEur, 1.15);

    fs.writeFileSync(path.join(dir, "fx-rate.json"), "{not json");
    assert.equal((await m.loadFxRate({ dir, now: () => T0, fetchText: failing })).source, "built-in", "a broken cache file is ignored");
    fs.writeFileSync(path.join(dir, "fx-rate.json"), JSON.stringify({ usdPerEur: -3, date: "x", fetchedAt: T0 }));
    assert.equal((await m.loadFxRate({ dir, now: () => T0, fetchText: failing })).source, "built-in", "so is a cached rate that is junk");
    fs.writeFileSync(path.join(dir, "fx-rate.json"), JSON.stringify({ usdPerEur: 1.2, date: "2026-11-03", fetchedAt: T0 + 1e9 }));
    await m.loadFxRate({ dir, now: () => T0, fetchText: failing });
    assert.equal(calls, 6, "a cache stamped in the future (clock moved back) counts as stale");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // A cap typed in euros is stored in dollars and read back as the same euros.
  for (const usdPerEur of [1.1216, 1.0, 1.0837, 1.2, 0.93]) {
    const rate = { usdPerEur, date: "t", source: "ecb" };
    for (let cents = 1; cents <= 20000; cents += 37) {
      const typed = (cents / 100).toFixed(2);
      const usd = m.usdFromEurField(typed, rate);
      assert.ok(usd > 0);
      assert.equal(m.eurFieldFromUsd(usd, rate), String(Number(typed)), `€${typed} at ${usdPerEur}`);
    }
  }
  assert.equal(m.usdFromEurField("", R), undefined);
  assert.equal(m.usdFromEurField("0", R), undefined);
  assert.equal(m.usdFromEurField("-2", R), undefined);
  assert.equal(m.usdFromEurField("abc", R), undefined);
  assert.equal(m.usdFromEurField("0.00001", R), 0.0001, "an amount too small to register still limits, not removes");
  const tiny = m.usdFromEurField("0.001", R);
  assert.equal(tiny, 0.0013);
  assert.ok(Number(m.eurFieldFromUsd(tiny, R)) > 0, "a sub-cent limit reopens as a positive amount: " + m.eurFieldFromUsd(tiny, R));
  assert.equal(m.usdFromEurFieldKeeping(m.eurFieldFromUsd(tiny, R), m.shownLimit(tiny, R), R), tiny);
  assert.equal(m.guardDraftProblem ? m.guardDraftProblem(m.eurFieldFromUsd(tiny, R), "") : null, null, "and passes the editor's own check");
  assert.ok(Number.isFinite(m.usdFromEurField("1e305", R)) && m.usdFromEurField("1e305", R) > 1e9, "an absurd amount stays a huge limit");
  assert.equal(m.usdFromEurField("1,6", R), 2, "a decimal comma reads as a point");

  // Through the editor's draft: stored dollars -> field -> stored dollars.
  m.setMoneyRate({ usdPerEur: 1.1216, date: "2026-11-02", source: "ecb" });
  const job = {
    name: "j",
    trigger: { kind: "manual" },
    loop: { kind: "once", stop: { budgetUsd: 2 } },
    guard: { monthlyCapUsd: 20 },
    graph: undefined,
    worker: { model: "m", effort: "low" },
  };
  const draft = m.draftFromJob({ ...job, input: { workspaceId: "w", workspaceName: "w", cwd: "/", initialUserNote: "x", planTitle: "x" }, prompt: { template: "x" }, history: [], state: { status: "idle" } });
  assert.equal(draft.loop.monthlyCap, "17.83", "$20.00 shows as euros");
  assert.equal(draft.loop.budget, "1.78");
  assert.deepEqual(m.buildGuard(draft.loop), { monthlyCapUsd: 20 }, "left alone, the stored dollars do not move");
  assert.equal(m.buildLoop(draft.loop).stop.budgetUsd, 2);
  // The rate arrives after the editor opened: untouched fields still keep their dollars.
  m.setMoneyRate({ usdPerEur: 1.2, date: "2026-11-03", source: "ecb" });
  assert.deepEqual(m.buildGuard(draft.loop), { monthlyCapUsd: 20 }, "a rate that moved meanwhile does not nudge an untouched cap");
  assert.equal(m.buildLoop(draft.loop).stop.budgetUsd, 2);
  m.setMoneyRate({ usdPerEur: 1.1216, date: "2026-11-02", source: "ecb" });
  draft.loop.monthlyCap = "25";
  assert.deepEqual(m.buildGuard(draft.loop), { monthlyCapUsd: 28.04 }, "edited, euros convert at today's rate");
  assert.equal(m.eurFieldFromUsd(28.04), "25");
  draft.loop.monthlyCap = "x";
  assert.equal(m.buildGuard(draft.loop), undefined, "a typo is dropped, not stored");

  // The builder: euros typed, dollars out.
  const sentence = { ...m.emptySentence(), name: "n", prompt: "p", budget: "2", monthlyCap: "20" };
  assert.equal(m.sentenceBudget(sentence), 2.2432);
  const input = m.sentenceToInput(sentence, { workspaceId: "w", workspaceName: "w", cwd: "/" });
  assert.equal(input.guard.monthlyCapUsd, 22.432);
  assert.equal(input.loop.stop.budgetUsd, 2.2432);

  console.log("money: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
