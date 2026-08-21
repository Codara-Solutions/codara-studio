"use strict";

// `cora status` — is the app up, and what is Cora doing right now?

const { rpcRaw, homeDir } = require("../lib/rpc.cjs");
const { listRuns } = require("../lib/store.cjs");
const { c, statusColor, table, timeAgo } = require("../lib/ui.cjs");

async function status(args, flags) {
  const info = await rpcRaw(flags, "app.info", {}).catch(() => null);
  const accounts = await rpcRaw(flags, "accounts.list", {}).catch(() => null);
  const runs = listRuns(flags);
  const active = runs.filter((run) => ["working", "running", "blocked", "paused"].includes(run.status));

  if (flags.json) {
    console.log(JSON.stringify({
      app: info?.result ?? null,
      accounts: accounts?.result?.accounts ?? null,
      activeRuns: active,
      totalRuns: runs.length,
    }, null, 2));
    return;
  }

  if (info?.result) {
    const app = info.result;
    console.log(`${c.green("●")} Codara Studio is running  ${c.dim(`v${app.version ?? "?"} · home ${homeDir(flags)}`)}`);
  } else {
    console.log(`${c.red("●")} Codara Studio is not reachable ${c.dim(`(home ${homeDir(flags)})`)}`);
    console.log(c.dim("  offline commands still work: runs, run, log, agents"));
  }

  const accountRows = accounts?.result?.accounts ?? [];
  if (accountRows.length > 0) {
    console.log("");
    console.log(c.bold("subscriptions"));
    const paint = (percent) =>
      percent === null || percent === undefined
        ? c.dim("?")
        : percent <= 10
          ? c.red(`${percent}%`)
          : percent <= 35
            ? c.yellow(`${percent}%`)
            : c.green(`${percent}%`);
    console.log(
      table(
        accountRows.map((account) => {
          const windows = (account.windows ?? [])
            .map((w) => `${w.label} ${paint(w.remainingPercent)}${w.resetsIn ? c.dim(` (${w.resetsIn})`) : ""}`)
            .join("  ");
          return [
            `  ${account.provider}`,
            account.label ?? account.id?.slice(0, 10) ?? "",
            account.isDefault ? c.dim("default") : "",
            windows || `${paint(account.remainingPercent)} left`,
          ];
        }),
      ),
    );
  }

  console.log("");
  if (active.length === 0) {
    console.log(c.dim(`no active runs (${runs.length} total — \`cora runs\` to list)`));
    return;
  }
  console.log(c.bold(`${active.length} active run${active.length === 1 ? "" : "s"}`));
  console.log(
    table(
      active.map((run) => [
        c.cyan(run.id.slice(0, 22)),
        statusColor(run.status),
        `${(run.workerTasks ?? []).length} workers`,
        timeAgo(run.updatedAt),
        run.title ?? "",
      ]),
    ),
  );
  console.log(c.dim("\n`cora watch` for the live dashboard"));
}

module.exports = { status };
