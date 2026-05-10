// Stub for @shared/types — hidden gates only need the runtime, not the
// type definitions. Returning an empty module is sufficient because the TS
// compiler emits the imports as `require()` calls that throw if not stubbed.
"use strict";
module.exports = {};
