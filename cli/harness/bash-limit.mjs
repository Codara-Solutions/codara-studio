// A bash call always ends. Pi's bash tool runs with no time limit unless the model
// names one, so a command that hangs holds the whole run for as long as it hangs.
// This is Pi's own tool with a limit applied to every call.

/** Longer than Claude Code's two minutes because that one moves a late command to
 * the background, where this one kills it, and a kill can skip a cleanup step. */
const DEFAULT_SECONDS = 300;
/** Past this a job belongs in the background, where a long build still works. */
const MAX_SECONDS = 1800;
/** What Pi's timer takes in seconds (2^31 - 1 ms). */
const LARGEST_SECONDS = 2_147_483;
/** Time for Pi's own kill to end the call before this one stops waiting for it. */
const HARD_STOP_MS = 2000;

const positive = (value, fallback) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

/** @param value  `bashTimeout` from settings.json: { defaultSeconds, maxSeconds } */
export function bashTimeoutSettings(value) {
  const defaultSeconds = Math.min(positive(value?.defaultSeconds, DEFAULT_SECONDS), LARGEST_SECONDS);
  // A longer default than the maximum means the owner wants more, not less.
  return { defaultSeconds, maxSeconds: Math.min(Math.max(positive(value?.maxSeconds, MAX_SECONDS), defaultSeconds), LARGEST_SECONDS) };
}

export function callLimit(requested, { defaultSeconds, maxSeconds }) {
  return Math.min(positive(Number(requested), defaultSeconds), maxSeconds);
}

export function timedOutLine(seconds) {
  return `Command timed out after ${seconds} seconds and was killed with its child processes. Any later commands in this same call did not run, so check for skipped steps such as a restore or cleanup.`;
}

/**
 * Pi's timer kills the process group, but its wait reads on while anything still
 * writes to the pipe, and a process that left the group with setsid can do that
 * forever. So the call stops waiting shortly after, and such a process is left behind.
 */
function operations({ exec }) {
  return {
    exec(command, cwd, options) {
      let timer;
      const hardStop = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${options.timeout}`)), options.timeout * 1000 + HARD_STOP_MS);
      });
      return Promise.race([exec(command, cwd, options), hardStop]).finally(() => clearTimeout(timer));
    },
  };
}

/**
 * Replaces Pi's bash tool with the same tool under a limit. The description and the
 * parameter both say so, because Pi's say there is no default. Pi turns on every
 * tool an extension adds, so one that was off has to be turned off again.
 * @param engine  { createBashToolDefinition, createLocalBashOperations, shellPath, commandPrefix }
 * @param limits  from bashTimeoutSettings
 * @param startsOff  no setting or flag left bash on for this session
 */
export function registerBashLimit(pi, engine, limits, startsOff) {
  const { shellPath, commandPrefix } = engine;
  if (startsOff) pi.on("session_start", () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "bash")));
  const bash = engine.createBashToolDefinition(process.cwd(), {
    shellPath,
    commandPrefix,
    operations: operations(engine.createLocalBashOperations({ shellPath })),
  });
  pi.registerTool({
    ...bash,
    description: bash.description.replace(
      "Optionally provide a timeout in seconds.",
      `A command is killed after ${limits.defaultSeconds} seconds unless timeout sets a longer limit, up to ${limits.maxSeconds}. ` +
        "Give long builds and test runs an explicit timeout, or run them in the background with nohup and a log file, then check the log.",
    ),
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: `Timeout in seconds. Default ${limits.defaultSeconds}, maximum ${limits.maxSeconds}.` },
      },
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const timeout = callLimit(params.timeout, limits);
      try {
        return await bash.execute(toolCallId, { ...params, timeout }, signal, onUpdate, ctx);
      } catch (error) {
        const status = `Command timed out after ${timeout} seconds`;
        if (error.message?.endsWith(status)) error.message = `${error.message.slice(0, -status.length)}${timedOutLine(timeout)}`;
        throw error;
      }
    },
  });
}
