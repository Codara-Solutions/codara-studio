#!/usr/bin/env node
"use strict";

// scripts/ssh-test-host-key.cjs skips a generated host key that ssh2 itself
// cannot parse (issue 202), and fails clearly when none ever parses.
//
//   node scripts/test-ssh-test-host-key.cjs

const assert = require("node:assert/strict");
const { utils } = require("ssh2");
const { generateAcceptedHostKey } = require("./ssh-test-host-key.cjs");

// The fixture itself comes from the helper: a raw generated key would fail
// this test by chance, which is the flake being fixed.
const good = generateAcceptedHostKey();
assert.ok(!(utils.parseKey(good) instanceof Error), "fixture key must parse");

// A malformed key first, a good one second: the helper returns the good one.
const queue = ["-----BEGIN OPENSSH PRIVATE KEY-----\nbroken\n-----END OPENSSH PRIVATE KEY-----\n", good];
assert.equal(generateAcceptedHostKey(() => queue.shift()), good);
assert.equal(queue.length, 0);

// The default generator returns something the server library accepts.
assert.ok(!(utils.parseKey(generateAcceptedHostKey()) instanceof Error));

// Never parses: a clear error, not an endless loop.
let calls = 0;
assert.throws(() => generateAcceptedHostKey(() => (calls++, "garbage")), /Could not generate an SSH host key/);
assert.ok(calls > 1 && calls < 100);

console.log("ssh test host key: ok");
