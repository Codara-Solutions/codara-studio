import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

test("the default Cora manager runs through Pi and can explain work on the persisted whiteboard", async () => {
  test.setTimeout(240_000);
  test.skip(
    process.env.CODARA_E2E_PI_MANAGER_LIVE !== "1",
    "Set CODARA_E2E_PI_MANAGER_LIVE=1 to use the isolated Codex OAuth subscription.",
  );

  const root = await mkdtemp(join(tmpdir(), "codara-live-pi-manager-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const piConfigDir = join(userDataDir, "pi-agent");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(piConfigDir, { recursive: true, mode: 0o700 }),
  ]);
  await copyFile(join(homedir(), ".Codara", "pi-agent", "auth.json"), join(piConfigDir, "auth.json"));
  await chmod(join(piConfigDir, "auth.json"), 0o600);
  await writeFile(
    join(workspaceDir, "README.md"),
    "# Pi manager fixture\n\nCora coordinates bounded workers and durable visual explanations.\n",
    "utf8",
  );
  await writeFile(join(userDataDir, "spark-state.json"), JSON.stringify({
    workspaces: [{
      id: "ws-live-pi-manager",
      name: "pi-manager-fixture",
      cwd: workspaceDir,
      color: "#42D6C7",
      workers: [],
    }],
    activeWorkspaceId: "ws-live-pi-manager",
  }, null, 2), "utf8");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForLoadState("domcontentloaded");

    const runId = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.startAutopilot({
        workspaceId: "ws-live-pi-manager",
        workspaceName: "pi-manager-fixture",
        cwd,
        // Deliberately omit backend/model/effort: this is the product default
        // gate, not merely a direct invocation of the Pi backend.
        // Auto must keep the execute roster available without forcing a
        // read-only/conversational turn through codara_complete.
        chatMode: "auto",
        initialUserNote: [
          "Read README.md.",
          "Use codara_whiteboard_update to create a board titled 'Pi manager proof' with two connected nodes titled 'Cora' and 'Verified answer'.",
          "Then include the marker CORA_PI_MANAGER_OK in your concise answer.",
          "Do not create workers or modify workspace files.",
        ].join(" "),
      });
      return run.id as string;
    }, workspaceDir);

    const coraTab = page.getByRole("tab", { name: "Cora" });
    await expect(coraTab).toBeVisible({ timeout: 10_000 });
    await coraTab.dispatchEvent("click");
    if (process.env.CODARA_PI_MANAGER_WORKING_SCREENSHOT) {
      await page.screenshot({ path: process.env.CODARA_PI_MANAGER_WORKING_SCREENSHOT });
    }

    await expect.poll(async () => (await readRun(userDataDir, runId)).status, { timeout: 180_000 }).toBe("complete");
    const finished = await readRun(userDataDir, runId);
    expect(finished.chatBackend).toBe("pi");
    expect(finished.chatModel).toBe("gpt-5.6-sol");
    expect(finished.chatEffort).toBe("high");
    expect(finished.sparkCalls.at(-1)?.model).toBe("gpt-5.6-sol");
    expect(finished.workerTasks).toHaveLength(0);
    expect(finished.humanMessages.some((message: any) =>
      message.author === "spark" && message.message.includes("CORA_PI_MANAGER_OK"),
    )).toBe(true);
    expect(finished.whiteboard?.title).toBe("Pi manager proof");
    expect(finished.whiteboard?.nodes?.map((node: any) => node.title)).toEqual(
      expect.arrayContaining(["Cora", "Verified answer"]),
    );
    const events = await readEvents(userDataDir, runId);
    expect(events.some((event: any) =>
      event.type === "chat.tool_use" && event.payload?.toolName === "codara_complete",
    )).toBe(false);
    expect(events.some((event: any) =>
      event.type === "chat.tool_result" && event.payload?.isError === true,
    )).toBe(false);

    await page.getByRole("tab", { name: "Whiteboard", exact: true }).dispatchEvent("click");
    const whiteboard = page.getByTestId("cora-whiteboard-surface");
    await expect(whiteboard.getByRole("heading", { name: "Pi manager proof" })).toBeVisible();
    await expect(whiteboard.getByText("Verified answer", { exact: true })).toBeVisible();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function readRun(userDataDir: string, runId: string): Promise<any> {
  const direct = join(userDataDir, "runs", runId, "run.json");
  try {
    return JSON.parse(await readFile(direct, "utf8"));
  } catch {
    for (const entry of await readdir(join(userDataDir, "runs"))) {
      const parsed = JSON.parse(await readFile(join(userDataDir, "runs", entry, "run.json"), "utf8"));
      if (parsed.id === runId) return parsed;
    }
    throw new Error(`Run ${runId} not found`);
  }
}

async function readEvents(userDataDir: string, runId: string): Promise<any[]> {
  const text = await readFile(join(userDataDir, "runs", runId, "events.jsonl"), "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
