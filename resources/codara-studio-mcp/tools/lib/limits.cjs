"use strict";

// A browser wait must end before the client gives up on the call
// (PREVIEW_TERMINAL_TIMEOUT_MS in ../../server.js).
const PREVIEW_WAIT_MAX_MS = 50_000;

module.exports = { PREVIEW_WAIT_MAX_MS };
