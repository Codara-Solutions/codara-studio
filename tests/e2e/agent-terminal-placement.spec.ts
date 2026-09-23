import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// An agent's codara_terminal_create used to open in whichever workspace was on
// screen when the call landed. The agent here runs in a workspace A pane while
// the user looks at workspace B; both of its terminals must open in A, right
// beside its own tab. The second call clears the pane id from its environment
// the way Codex does for MCP servers, so only the process tree can place it.

const SERVER = resolve(__dirname, "../../resources/codara-studio-mcp/server.js");

function agentCall(signalDir: string, gate: string, title: string, clearEnv: boolean): string {
  const create = `require('${SERVER}').callToolByName('codara_terminal_create', { cwd: process.cwd(), title: '${title}' })`;
  const node = `${clearEnv ? "env -u SPARK_AGENT_PANE_ID -u SPARK_PANE_ID " : ""}${JSON.stringify(process.execPath)} -e "${create}"`;
  return `while [ ! -f ${JSON.stringify(join(signalDir, gate))} ]; do sleep 0.2; done; ${node}`;
}

async function stripTitles(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-tab-id]"))
      .map((el) => /\b(caller|other|from-env|from-pid)\b/.exec(el.textContent ?? "")?.[1])
      .filter((title): title is string => Boolean(title)),
  );
}

test("an agent's terminals open beside its own pane, not in the workspace on screen", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-agent-placement-"));
  const home = join(root, "home");
  const signals = join(root, "signals");
  const cwdA = join(root, "workspace-a");
  const cwdB = join(root, "workspace-b");
  await Promise.all([mkdir(home), mkdir(signals), mkdir(cwdA), mkdir(cwdB)]);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [
        { id: "ws-a", name: "Workspace A", cwd: cwdA, color: "#42D6C7", workers: [] },
        { id: "ws-b", name: "Workspace B", cwd: cwdB, color: "#F0C419", workers: [] },
      ],
    }),
  );
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();

    await request("terminal.create", {
      cwd: cwdA,
      title: "caller",
      command: `${agentCall(signals, "go1", "from-env", false)}; ${agentCall(signals, "go2", "from-pid", true)}`,
    });
    await request("terminal.create", { cwd: cwdA, title: "other" });
    await expect.poll(() => stripTitles(page)).toEqual(["caller", "other"]);

    await page.locator('[data-workspace-id="ws-b"]').click();
    await expect.poll(() => stripTitles(page)).toEqual([]);
    await writeFile(join(signals, "go1"), "");
    await page.waitForTimeout(4_000);
    await writeFile(join(signals, "go2"), "");
    await page.waitForTimeout(4_000);
    expect(await stripTitles(page), "nothing opened in the workspace on screen").toEqual([]);

    await page.locator('[data-workspace-id="ws-a"]').click();
    await expect
      .poll(() => stripTitles(page), { timeout: 20_000 })
      .toEqual(["caller", "from-env", "from-pid", "other"]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
