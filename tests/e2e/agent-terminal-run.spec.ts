import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// codara_terminal_run against a real shell with Codara's shell integration:
// the exit marker ends the wait and carries the exit code, a cursor read
// returns only newer output, and a pane still running a command is refused
// instead of having a second command typed into it.

test("terminal.run waits for the shell's exit marker and reads continue from its cursor", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-agent-run-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-run",
      workspaces: [{ id: "ws-run", name: "Run", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  // A run from inside a Codara pane inherits that pane's opt-out, which would
  // leave the app's own shells without the markers under test.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "SPARK_NO_SHELL_INTEGRATION") env[key] = value;
  }
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      SHELL: "/bin/bash",
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 60_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-run"]')).toBeVisible();

    const ran = await request("terminal.run", {
      cwd,
      title: "runner",
      command: "echo run-output-$((40 + 2)); (exit 3)",
      timeoutMs: 30_000,
    });
    expect(ran.status).toBe("exited");
    expect(ran.exitCode).toBe(3);
    expect(ran.shellIntegration).toBe(true);
    expect(ran.output).toContain("run-output-42");
    expect(ran.output).not.toContain("$((40 + 2))");
    expect(ran.next).toMatch(/Pass this paneId to your next codara_terminal_run/);

    const again = await request("terminal.run", { paneId: ran.paneId, command: "printf 'second\\n'" });
    expect(again.status).toBe("exited");
    expect(again.exitCode).toBe(0);
    expect(again.output.trim()).toBe("second");

    // Parallel calls on one pane would type two commands into one shell and
    // each read the other's exit marker; the second is refused instead.
    const parallel = await Promise.allSettled([
      request("terminal.run", { paneId: ran.paneId, command: "sleep 1; echo parallel-one" }),
      request("terminal.run", { paneId: ran.paneId, command: "sleep 1; echo parallel-two" }),
    ]);
    const finished = parallel.filter((outcome) => outcome.status === "fulfilled");
    const refused = parallel.filter((outcome) => outcome.status === "rejected");
    expect(finished).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/already has a codara_terminal_run in progress/);
    const winner = (finished[0] as PromiseFulfilledResult<{ status: string; exitCode: number; output: string }>).value;
    expect(winner.status).toBe("exited");
    expect(winner.exitCode).toBe(0);
    expect(winner.output).toMatch(/^parallel-(one|two)$/m);

    await request("terminal.write", { paneId: ran.paneId, text: "echo after-cursor" });
    await expect
      .poll(async () => (await request("terminal.read", { paneId: ran.paneId, since: again.cursor })).text, {
        timeout: 15_000,
      })
      .toContain("after-cursor");
    const fresh = await request("terminal.read", { paneId: ran.paneId, since: again.cursor });
    expect(fresh.text).not.toContain("second");
    const screen = await request("terminal.read", { paneId: ran.paneId, mode: "screen" });
    expect(screen.altScreen).toBe(false);
    expect(screen.text).toContain("run-output-42");

    const listed = await request("terminal.list", {});
    const runner = listed.panes.find((pane: { paneId: string }) => pane.paneId === ran.paneId);
    expect(runner).toMatchObject({ shell: "idle", writable: true });

    const slow = await request("terminal.run", { paneId: ran.paneId, command: "sleep 30", timeoutMs: 1_000 });
    expect(slow.status).toBe("timeout");
    await expect(request("terminal.run", { paneId: ran.paneId, command: "echo too-soon" })).rejects.toThrow(
      /still running a command/,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
