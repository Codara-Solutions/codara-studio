"use strict";
const assert = require("node:assert/strict");
const { startVisionFixture } = require("../cli/bench/browser/vision-fixture.cjs");
(async () => {
  const fixture = await startVisionFixture();
  try {
    const { streams, expected } = fixture.snapshot();
    assert.equal(new Set(streams.map(s => s.value)).size, 6);
    assert.equal(expected.value, Math.min(...streams.map(s => s.value)));
    assert.ok(fixture.grade().every(check => !check.pass));
    const page = await (await fetch(fixture.url)).text();
    assert.match(page, /<canvas/);
    const rendered = page.replace(/<script>[\s\S]*?<\/script>/g, "");
    for (const stream of streams) assert.ok(!rendered.includes(stream.name), "stream labels must require visual grounding");
    const confirm = choice => fetch(fixture.url + "confirm", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({choice})});
    assert.equal((await confirm(-1)).status, 400);
    assert.equal(fixture.snapshot().commits, 0);
    const beforeSave = Date.now();
    assert.equal((await confirm(expected.id)).status, 200);
    assert.ok(fixture.snapshot().confirmedAt >= beforeSave);
    assert.equal(fixture.grade().find(c => c.name === "saved selection reloaded").pass, false);
    await fetch(fixture.url);
    assert.ok(fixture.grade().every(check => check.pass));
    await confirm(streams.find(stream => stream.id !== expected.id).id);
    assert.equal(fixture.grade().find(c => c.name === "lowest displayed latency selected").pass, false);
    assert.equal(fixture.grade().find(c => c.name === "exactly one confirmation saved").pass, false);
  } finally { await fixture.close(); }
  console.log("vision fixture outcome checks passed");
})().catch(error => {console.error(error);process.exitCode=1;});
