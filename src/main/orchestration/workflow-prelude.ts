// Guest-side JavaScript evaluated inside every QuickJS context before the
// workflow body. It is the script's whole API surface: agent, parallel,
// pipeline, phase, log, budget, workflow and args. The only ways out of the
// context are the __wf* host functions it captures and then deletes, and they
// take and return JSON text, never object handles.

export const WORKFLOW_SCRIPT_FILENAME = "workflow.js";

export const WORKFLOW_PRELUDE = String.raw`(function () {
  "use strict";
  var hostCall = globalThis.__wfHost;
  var hostNote = globalThis.__wfNote;
  var hostChild = globalThis.__wfChild;
  var hostFinish = globalThis.__wfFinish;
  var hostBudget = globalThis.__wfBudget;
  var init = JSON.parse(globalThis.__wfInit);
  delete globalThis.__wfHost;
  delete globalThis.__wfNote;
  delete globalThis.__wfChild;
  delete globalThis.__wfFinish;
  delete globalThis.__wfBudget;
  delete globalThis.__wfInit;

  var MAX_ITEMS = init.maxItems;
  var currentPhase = init.defaultPhase;

  Math.random = function () {
    throw new Error("Math.random() is not available in workflows (it breaks resume); vary prompts by index instead");
  };
  var RealDate = Date;
  function SafeDate() {
    if (!new.target) throw new Error("Date() is not available in workflows (it breaks resume); pass dates in args");
    if (arguments.length === 0) {
      throw new Error("new Date() without a value is not available in workflows (it breaks resume); pass dates in args");
    }
    return Reflect.construct(RealDate, Array.prototype.slice.call(arguments), new.target);
  }
  SafeDate.prototype = RealDate.prototype;
  SafeDate.parse = RealDate.parse;
  SafeDate.UTC = RealDate.UTC;
  SafeDate.now = function () {
    throw new Error("Date.now() is not available in workflows (it breaks resume); pass dates in args");
  };
  Object.defineProperty(RealDate.prototype, "constructor", { value: SafeDate, writable: true, configurable: true });
  globalThis.Date = SafeDate;

  function errorText(error) {
    if (error && typeof error === "object" && typeof error.message === "string") {
      var name = typeof error.name === "string" && error.name !== "Error" ? error.name + ": " : "";
      var where = "";
      if (typeof error.stack === "string") {
        var match = /workflow\.js:(\d+)/.exec(error.stack);
        if (match) where = " (line " + match[1] + ")";
      }
      return name + error.message + where;
    }
    return String(error);
  }

  function show(value) {
    if (typeof value === "string") return value;
    try {
      var text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch (e) {
      return String(value);
    }
  }

  function phaseName(title) {
    var text = String(title === undefined || title === null ? "" : title).trim();
    if (!text) throw new TypeError("phase(title): title must be a non-empty string");
    return init.phasePrefix ? init.phasePrefix + ": " + text : text;
  }

  function settle(value) {
    return value === undefined ? null : value;
  }

  function reportItem(kind, index, error) {
    hostNote("log", JSON.stringify(kind + " item " + index + " resolved null: " + errorText(error)));
  }

  function agent(prompt, opts) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      return Promise.reject(new TypeError("agent(prompt, opts): prompt must be a non-empty string"));
    }
    if (opts !== undefined && opts !== null && (typeof opts !== "object" || Array.isArray(opts))) {
      return Promise.reject(new TypeError("agent(prompt, opts): opts must be an object"));
    }
    var options = opts ? Object.assign({}, opts) : {};
    var payload;
    try {
      if (options.phase !== undefined) options.phase = phaseName(options.phase);
      payload = JSON.stringify({
        prompt: prompt,
        opts: options,
        phase: options.phase !== undefined ? options.phase : currentPhase,
      });
    } catch (error) {
      return Promise.reject(error instanceof TypeError ? error : new TypeError("agent(prompt, opts): opts must be plain JSON"));
    }
    return hostCall("agent", payload).then(function (text) {
      var reply = JSON.parse(text);
      if (!reply.ok) throw new Error(reply.error);
      return settle(reply.value);
    });
  }

  function parallel(thunks) {
    if (!Array.isArray(thunks)) {
      return Promise.reject(new TypeError("parallel(thunks) needs an array of functions"));
    }
    if (thunks.length > MAX_ITEMS) {
      return Promise.reject(new RangeError("parallel() takes at most " + MAX_ITEMS + " items"));
    }
    return Promise.all(thunks.map(function (thunk, index) {
      var pending;
      try {
        pending = typeof thunk === "function" ? thunk() : thunk;
      } catch (error) {
        reportItem("parallel", index, error);
        return null;
      }
      return Promise.resolve(pending).then(settle, function (error) {
        reportItem("parallel", index, error);
        return null;
      });
    }));
  }

  function pipeline(items) {
    var stages = Array.prototype.slice.call(arguments, 1);
    if (!Array.isArray(items)) {
      return Promise.reject(new TypeError("pipeline(items, ...stages) needs an array of items"));
    }
    if (items.length > MAX_ITEMS) {
      return Promise.reject(new RangeError("pipeline() takes at most " + MAX_ITEMS + " items"));
    }
    for (var s = 0; s < stages.length; s += 1) {
      if (typeof stages[s] !== "function") {
        return Promise.reject(new TypeError("pipeline(): every stage must be a function"));
      }
    }
    return Promise.all(items.map(function (item, index) {
      var chain = Promise.resolve(item);
      stages.forEach(function (stage) {
        chain = chain.then(function (prev) {
          return stage(prev, item, index);
        });
      });
      return chain.then(settle, function (error) {
        reportItem("pipeline", index, error);
        return null;
      });
    }));
  }

  function phase(title) {
    currentPhase = phaseName(title);
    hostNote("phase", JSON.stringify(currentPhase));
  }

  function log(message) {
    hostNote("log", JSON.stringify(show(message)));
  }

  function workflow(nameOrRef, childArgs) {
    if (init.depth >= 1) {
      return Promise.reject(new Error("workflow(): nested workflows go one level deep"));
    }
    var name = typeof nameOrRef === "string" ? nameOrRef : nameOrRef && nameOrRef.name;
    if (typeof name !== "string" || !name.trim()) {
      return Promise.reject(new TypeError("workflow(name, args): name must be a saved workflow's name"));
    }
    var argsText;
    try {
      argsText = JSON.stringify(childArgs === undefined ? null : childArgs);
    } catch (error) {
      return Promise.reject(new TypeError("workflow(name, args): args must be plain JSON"));
    }
    return hostChild(name.trim(), argsText).then(function (text) {
      var reply = JSON.parse(text);
      if (!reply.ok) throw new Error(reply.error);
      return settle(reply.value);
    });
  }

  var budget = Object.freeze({
    total: init.budget.total,
    totalUsd: init.budget.totalUsd,
    spent: function () { return JSON.parse(hostBudget()).tokens; },
    spentUsd: function () { return JSON.parse(hostBudget()).usd; },
    remaining: function () {
      if (init.budget.total === null) return Infinity;
      return Math.max(0, init.budget.total - JSON.parse(hostBudget()).tokens);
    },
  });

  var consoleLike = {
    log: function () { log(Array.prototype.map.call(arguments, show).join(" ")); },
  };
  consoleLike.info = consoleLike.log;
  consoleLike.warn = consoleLike.log;
  consoleLike.error = consoleLike.log;

  globalThis.agent = agent;
  globalThis.parallel = parallel;
  globalThis.pipeline = pipeline;
  globalThis.phase = phase;
  globalThis.log = log;
  globalThis.budget = budget;
  globalThis.workflow = workflow;
  globalThis.console = consoleLike;
  globalThis.args = init.args;

  globalThis.__wfStart = function () {
    var main = globalThis.__wfMain;
    delete globalThis.__wfMain;
    delete globalThis.__wfStart;
    Promise.resolve()
      .then(function () { return main(); })
      .then(function (value) {
        var text;
        try {
          text = JSON.stringify({ ok: true, value: settle(value) });
        } catch (error) {
          text = JSON.stringify({ ok: false, error: "the workflow's return value is not plain JSON" });
        }
        hostFinish(text);
      }, function (error) {
        hostFinish(JSON.stringify({ ok: false, error: errorText(error) }));
      });
  };
})();
`;

/**
 * The body runs as the body of an async function, so top-level await and
 * return work. The wrapper sits on the body's first line, which keeps every
 * line number the sandbox reports equal to the line in the saved file.
 */
export function wrapWorkflowBody(body: string): string {
  return `globalThis.__wfMain = async function () {${body}\n};`;
}
