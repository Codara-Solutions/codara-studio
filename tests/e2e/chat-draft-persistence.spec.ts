import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Cora drafts survive editor and workspace navigation", async () => {
  const fixture = await prepareWorkspace();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForLoadState("domcontentloaded");

    const composer = () =>
      page.locator('textarea[placeholder="Tell Cora what to build, or describe a task."]:visible');
    const allComposers = () =>
      page.locator('textarea[placeholder="Tell Cora what to build, or describe a task."]');
    await expect(composer()).toBeVisible();
    await composer().fill("Workspace A keeps this unfinished prompt.");
    await composer().evaluate((element) => {
      element.setAttribute("data-retained-cora-probe", "workspace-a");
    });

    // Opening an editor keeps the Cora surface mounted but inert/hidden, so
    // its conversation and scroll position do not flash through a remount.
    await page.evaluate((path) => {
      window.dispatchEvent(new CustomEvent("spark:open-file", { detail: { path } }));
    }, fixture.workspaceAFile);
    await expect(page.getByRole("tab", { name: /README\.md/ })).toBeVisible();
    await expect(allComposers()).toHaveCount(1);
    await expect(composer()).toHaveCount(0);

    await openDraftChat(page);
    await expect(composer()).toHaveValue("Workspace A keeps this unfinished prompt.");
    await expect(composer()).toHaveAttribute("data-retained-cora-probe", "workspace-a");

    // A second workspace owns an independent draft under its own chat-tab key.
    await page.locator('[data-workspace-id="ws-draft-b"]').dispatchEvent("click");
    await expect(composer()).toBeVisible();
    await composer().fill("Workspace B has a different unfinished prompt.");

    // Workspace A restores its draft even though its remembered active tab is
    // the editor; selecting its Cora tab must recover the exact text.
    await page.locator('[data-workspace-id="ws-draft-a"]').dispatchEvent("click");
    await openDraftChat(page);
    await expect(composer()).toHaveValue("Workspace A keeps this unfinished prompt.");
    await expect(composer()).toHaveAttribute("data-retained-cora-probe", "workspace-a");

    await page.locator('[data-workspace-id="ws-draft-b"]').dispatchEvent("click");
    await expect(composer()).toHaveValue("Workspace B has a different unfinished prompt.");
  } finally {
    await app?.close();
  }
});

test("loaded Cora conversations stay mounted across workspace navigation", async () => {
  const fixture = await prepareWorkspace();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForLoadState("domcontentloaded");

    await seedConversation(
      page,
      "ws-draft-a",
      "workspace-a",
      fixture.workspaceADir,
      "Workspace A conversation",
      "A retained conversation message",
      "gpt-5.6-luna",
    );
    const conversation = page.locator('[aria-hidden="false"] [data-testid="cora-conversation"]');
    await expect(page.getByText("A retained conversation message", { exact: true })).toBeVisible();
    await conversation.evaluate((element) => {
      element.setAttribute("data-retained-conversation-probe", "workspace-a");
    });
    const modelButton = page.locator('[aria-hidden="false"] button[title="Chat model"]');
    await expect(modelButton).toHaveText(/GPT-5\.6 Luna/);
    await modelButton.evaluate((element) => {
      element.setAttribute("data-retained-model-probe", "workspace-a");
    });

    await page.locator('[data-workspace-id="ws-draft-b"]').dispatchEvent("click");
    await seedConversation(
      page,
      "ws-draft-b",
      "workspace-b",
      fixture.workspaceBDir,
      "Workspace B conversation",
      "B retained conversation message",
      "gpt-5.6-terra",
    );
    await expect(page.getByText("B retained conversation message", { exact: true })).toBeVisible();
    await expect(page.locator('[aria-hidden="false"] button[title="Chat model"]')).toHaveText(
      /GPT-5\.6 Terra/,
    );

    await page.evaluate(() => {
      const labels: string[] = [];
      const sample = () => {
        const button = document.querySelector(
          '[aria-hidden="false"] button[title="Chat model"]',
        );
        const label = button?.textContent?.trim();
        if (label && labels[labels.length - 1] !== label) labels.push(label);
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      sample();
      (window as unknown as { __coraModelProbe: { labels: string[]; observer: MutationObserver } })
        .__coraModelProbe = { labels, observer };
    });

    await page.locator('[data-workspace-id="ws-draft-a"]').dispatchEvent("click");
    await expect(
      page.locator('[aria-hidden="false"] [data-testid="cora-conversation"]'),
    ).toHaveAttribute(
      "data-retained-conversation-probe",
      "workspace-a",
    );
    await expect(page.getByText("A retained conversation message", { exact: true })).toBeVisible();
    const restoredModel = page.locator('[aria-hidden="false"] button[title="Chat model"]');
    await expect(restoredModel).toHaveAttribute("data-retained-model-probe", "workspace-a");
    await expect(restoredModel).toHaveText(/GPT-5\.6 Luna/);
    const labels = await page.evaluate(() => {
      const probe = (
        window as unknown as {
          __coraModelProbe: { labels: string[]; observer: MutationObserver };
        }
      ).__coraModelProbe;
      probe.observer.disconnect();
      return probe.labels;
    });
    expect(labels.length).toBeGreaterThan(0);
    expect(
      labels.every((label) => label === "GPT-5.6 Terra" || label === "GPT-5.6 Luna"),
    ).toBe(true);
  } finally {
    await app?.close();
  }
});

async function openDraftChat(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: /New chat|Cora/ }).first();
  await expect(tab).toBeVisible();
  await tab.dispatchEvent("click");
}

async function seedConversation(
  page: Page,
  workspaceId: string,
  workspaceName: string,
  cwd: string,
  title: string,
  message: string,
  chatModel?: string,
): Promise<void> {
  await page.evaluate(
    async ({ workspaceId, workspaceName, cwd, title, message, chatModel }) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.createRun({
        workspaceId,
        workspaceName,
        cwd,
        title,
        ...(chatModel ? { chatBackend: "pi", chatModel } : {}),
      });
      await spark.orchestration.addRunMessage({
        runId: run.id,
        clientMessageId: `e2e-${run.id}`,
        author: "user",
        kind: "note",
        message,
        deliveryState: "acknowledged",
      });
    },
    { workspaceId, workspaceName, cwd, title, message, chatModel },
  );
  const history = page.getByRole("button", { name: "Open chat history" });
  await expect(history).toBeVisible({ timeout: 10_000 });
  await history.dispatchEvent("click");
  const option = page.getByRole("option", { name: new RegExp(title) });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.dispatchEvent("click");
}

async function prepareWorkspace(): Promise<{
  userDataDir: string;
  workspaceAFile: string;
  workspaceADir: string;
  workspaceBDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-chat-draft-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
  ]);
  const workspaceAFile = join(workspaceA, "README.md");
  await Promise.all([
    writeFile(workspaceAFile, "# Workspace A\n", "utf8"),
    writeFile(join(workspaceB, "README.md"), "# Workspace B\n", "utf8"),
  ]);
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-draft-a",
            name: "workspace-a",
            cwd: workspaceA,
            color: "#34D3C3",
            workers: [],
          },
          {
            id: "ws-draft-b",
            name: "workspace-b",
            cwd: workspaceB,
            color: "#78A8FF",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-draft-a",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceAFile, workspaceADir: workspaceA, workspaceBDir: workspaceB };
}
