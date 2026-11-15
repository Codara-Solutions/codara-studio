"use strict";

// Host key for in-process ssh2 test servers. ssh2's own generateKeyPairSync
// ("ed25519") sometimes (about 4 in 1000) returns a key its own server then
// rejects with "Cannot parse privateKey: Malformed OpenSSH private key", which
// made tests fail by chance (issue 202). Keep the first generated key that
// parses.

const { utils } = require("ssh2");

const MAX_TRIES = 20;

function generateAcceptedHostKey(generate = () => utils.generateKeyPairSync("ed25519").private, parse = (key) => utils.parseKey(key)) {
  let lastError = "no attempt made";
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const key = generate();
    const parsed = parse(key);
    if (!(parsed instanceof Error)) return key;
    lastError = parsed.message;
  }
  throw new Error(`Could not generate an SSH host key that ssh2 accepts after ${MAX_TRIES} tries: ${lastError}`);
}

module.exports = { generateAcceptedHostKey };
