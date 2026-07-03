// Headless eval argument parser.
//
// Codara normally launches as an Electron desktop app and ignores extra argv
// entries. The eval harness flips Codara into headless mode by passing
// `--eval-plan <path>` at startup; if that flag is present the main process
// branches to the headless runner before any BrowserWindow is created.
//
// We use the built-in node:util.parseArgs rather than depending on yargs /
// commander to keep the boot path dependency-free.

import { parseArgs } from "node:util";

export interface HeadlessEvalArgs {
  evalPlan: string;
  evalConfig?: string;
  evalOutputDir?: string;
  // Wall-clock budget in seconds. Headless runner enforces this and exits 124
  // when exceeded so the harness can record `timed_out`.
  evalBudgetSeconds?: number;
}

export interface HeadlessArgsResult {
  enabled: boolean;
  args?: HeadlessEvalArgs;
  // Populated when --eval-plan is missing or another flag has an invalid
  // value; the caller falls back to interactive mode and never inspects this.
  // For valid headless invocations with bad args we exit 2 with a message.
  error?: string;
}

// Inspect process.argv. Returns enabled=false when --eval-plan is absent so
// interactive Codara behaves identically to today. When the flag is present
// but other args are wrong, returns enabled=true with a populated `error`
// string the caller logs before exiting 2.
export function readHeadlessEvalArgs(argv: string[] = process.argv): HeadlessArgsResult {
  // Electron prepends the executable + sometimes a script path; the user's
  // arguments come after. parseArgs is tolerant of leading positionals so we
  // just hand it everything past argv[0] and rely on `strict: false` to ignore
  // anything Electron itself uses.
  const trimmed = argv.slice(1);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: trimmed,
      options: {
        "eval-plan": { type: "string" },
        "eval-config": { type: "string" },
        "eval-output-dir": { type: "string" },
        "eval-budget": { type: "string" },
      },
      // Electron forwards its own flags (e.g. --user-data-dir, --enable-logging)
      // through argv. strict:false lets parseArgs ignore anything we did not
      // declare without throwing.
      strict: false,
      allowPositionals: true,
    });
  } catch (err) {
    return { enabled: false, error: (err as Error).message };
  }

  const values = parsed.values as Record<string, unknown>;
  const planRaw = values["eval-plan"];
  if (typeof planRaw !== "string" || !planRaw.trim()) {
    return { enabled: false };
  }

  const configRaw = values["eval-config"];
  const outputDirRaw = values["eval-output-dir"];
  const budgetRaw = values["eval-budget"];

  let budget: number | undefined;
  if (typeof budgetRaw === "string" && budgetRaw.trim().length > 0) {
    const parsedBudget = Number(budgetRaw);
    if (!Number.isFinite(parsedBudget) || parsedBudget <= 0) {
      return {
        enabled: true,
        error: `--eval-budget must be a positive number of seconds (got ${budgetRaw}).`,
      };
    }
    budget = parsedBudget;
  }

  return {
    enabled: true,
    args: {
      evalPlan: planRaw.trim(),
      evalConfig: typeof configRaw === "string" && configRaw.trim() ? configRaw.trim() : undefined,
      evalOutputDir:
        typeof outputDirRaw === "string" && outputDirRaw.trim() ? outputDirRaw.trim() : undefined,
      evalBudgetSeconds: budget,
    },
  };
}
