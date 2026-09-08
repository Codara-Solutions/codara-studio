"use strict";

const assert = require("node:assert/strict");
const { startTicketFixture, TARGET_ID, EXPECTED_NOTE } = require("../cli/bench/browser/ticket-fixture.cjs");

(async () => {
  const fixture = await startTicketFixture({ delayMs: 0 });
  try {
    const json = async (route) => (await fetch(new URL(route, fixture.url))).json();
    const save = (revision, overrides = {}) => fetch(new URL(`/api/tickets/${TARGET_ID}`, fixture.url), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, priority: "High", note: EXPECTED_NOTE, ...overrides }),
    });
    assert.equal(fixture.grade().every((check) => check.pass), false);
    const first = await json("/api/tickets?page=0");
    const second = await json("/api/tickets?page=1");
    assert.equal(first.rows.some((ticket) => ticket.id === TARGET_ID), false);
    assert.equal(second.rows.some((ticket) => ticket.id === TARGET_ID), true);
    assert.equal((await json(`/api/tickets?q=${TARGET_ID}`)).total, 1);
    assert.equal((await save(1, { note: "" })).status, 400);
    assert.equal((await save(1)).status, 409);
    assert.equal((await json(`/api/tickets/${TARGET_ID}`)).owner, "Morgan");
    assert.equal((await save(1)).status, 409, "stale writes never succeed");
    assert.equal((await save(2)).status, 200);
    assert.equal(fixture.grade().every((check) => check.pass), true);
    const snapshot = fixture.snapshot();
    snapshot.tickets[0].note = "tampered";
    assert.equal(fixture.snapshot().tickets[0].note, "", "the controller does not expose mutable oracle state");
  } finally {
    await fixture.close();
  }
  console.log("browser fixture contract tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
