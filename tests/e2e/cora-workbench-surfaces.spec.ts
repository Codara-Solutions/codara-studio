import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("every Cora run exposes a stable Runs surface immediately and the Whiteboard appears once a board exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "codara-cora-surfaces-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Surface fixture\n", "utf8");
  await writeFile(
    join(workspaceDir, "portable.coraboard"),
    JSON.stringify({
      format: "codara.whiteboard",
      version: 1,
      exportedAt: new Date().toISOString(),
      board: {
        version: 1,
        revision: 4,
        lastEditedBy: "user",
        title: "Portable architecture",
        summary: "A board that moved with the repository.",
        nodes: [{ id: "portable", kind: "topic", title: "Portable card", x: 20, y: 30 }],
        edges: [],
        updatedAt: new Date().toISOString(),
      },
    }, null, 2),
    "utf8",
  );
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{
        id: "ws-cora-surfaces",
        name: "surface-fixture",
        cwd: workspaceDir,
        color: "#42D6C7",
        workers: [],
      }],
      activeWorkspaceId: "ws-cora-surfaces",
    }, null, 2),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      // --ozone-platform=x11 keeps Linux launches deterministic: Chromium's
      // Wayland auto-detection can hang the whole app when the compositor
      // is unavailable to new clients (headless CI, stale sessions).
      args: [".", "--ozone-platform=x11"],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const created = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.createRun({
        workspaceId: "ws-cora-surfaces",
        workspaceName: "surface-fixture",
        cwd,
        title: "Immediate surfaces",
      });
      return {
        runId: run.id as string,
        backend: run.chatBackend as string,
        model: run.chatModel as string,
        effort: run.chatEffort as string,
      };
    }, workspaceDir);
    expect(created).toMatchObject({
      backend: "pi",
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(created.runId).toBeTruthy();

    await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: "Cora" }).click();

    // No plan, step, or worker exists. Chat and Runs must still be in the
    // first rendered run snapshot instead of appearing later after delegation.
    // The Whiteboard is deliberately conditional: with no board yet there is
    // no pill — only the quiet "New whiteboard" affordance.
    for (const name of ["Chat", "Runs"]) {
      await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("tab", { name: "Workers", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Whiteboard", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New whiteboard" })).toBeVisible();

    // As soon as a board exists (here: Cora persists one), the Whiteboard
    // pill joins the strip and the creation affordance retires.
    await page.evaluate(async (runId) => {
      const spark = (window as unknown as { spark: any }).spark;
      await spark.orchestration.updateWhiteboard({
        runId,
        action: "replace",
        title: "Request to verified change",
        summary: "A persisted Cora explanation.",
        nodes: [
          { id: "request", kind: "topic", title: "User request", body: "The outcome Cora is coordinating.", x: 80, y: 120 },
          { id: "worker", kind: "flow", title: "Pi worker", body: "Implements and verifies a bounded change.", x: 440, y: 120 },
        ],
        edges: [{ id: "delegates", from: "request", to: "worker", label: "delegates", tone: "accent" }],
      });
    }, created.runId);
    await expect(page.getByRole("tab", { name: "Whiteboard", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New whiteboard" })).toHaveCount(0);

    const chatTab = page.getByRole("tab", { name: "Chat", exact: true });
    const runsTab = page.getByRole("tab", { name: "Runs", exact: true });
    const whiteboardTab = page.getByRole("tab", { name: "Whiteboard", exact: true });
    await whiteboardTab.click();
    await expect(whiteboardTab).toHaveAttribute("aria-selected", "true");
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
    const selectedStyles = await page.getByRole("tablist").getByRole("tab").evaluateAll((tabs) =>
      tabs.map((tab) => ({
        label: tab.textContent?.trim(),
        selected: tab.getAttribute("aria-selected"),
        // Assert the authored state rather than a transition's interpolated
        // computed value. Electron test windows can be fully occluded, which
        // pauses compositor frames at transition time zero even though React
        // has already committed the selected style and ARIA state.
        background: (tab as HTMLElement).style.background,
        color: (tab as HTMLElement).style.color,
      })),
    );
    const selectedWhiteboard = selectedStyles.find((tab) => tab.label === "Whiteboard");
    const inactiveChat = selectedStyles.find((tab) => tab.label === "Chat");
    expect(selectedWhiteboard?.selected).toBe("true");
    expect(inactiveChat?.selected).toBe("false");
    expect(selectedWhiteboard?.background).not.toBe(inactiveChat?.background);
    expect(selectedWhiteboard?.color).not.toBe(inactiveChat?.color);
    await expect(page.getByTestId("cora-whiteboard-surface")).toBeVisible();
    await expect(page.getByText("Request to verified change")).toBeVisible();
    await expect(page.getByText("User request", { exact: true })).toBeVisible();
    await expect(page.getByText("Pi worker", { exact: true })).toBeVisible();

    // The surface is an editor, not a static diagram: a human can create and
    // rewrite a card and the exact manual edit lands in run state.
    await page.getByRole("button", { name: /Add card/ }).click();
    const cardInspector = page.getByRole("complementary", { name: "Whiteboard card inspector" });
    await expect(cardInspector).toBeVisible();
    const titleInput = cardInspector.getByRole("textbox", { name: "Title" });
    await titleInput.fill("Human-owned insight");
    await titleInput.press("Tab");
    await expect(page.getByText("Human-owned insight", { exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(async (runId) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.getRun(runId);
      return {
        editor: run?.whiteboard?.lastEditedBy,
        hasNode: run?.whiteboard?.nodes?.some((node: any) => node.title === "Human-owned insight"),
      };
    }, created.runId)).toEqual({ editor: "user", hasNode: true });

    // The canvas behaves like a diagram tool: an unmodified wheel zooms, while
    // dragging still pans through the unbounded coordinate space.
    const viewport = page.locator(".cora-board-editor .react-flow__viewport");
    const minimap = page.locator(".cora-board-editor .react-flow__minimap");
    const minimapSvg = minimap.locator("svg");
    const minimapBox = await minimap.boundingBox();
    const minimapSvgBox = await minimapSvg.boundingBox();
    expect(minimapBox).not.toBeNull();
    expect(minimapSvgBox).not.toBeNull();
    expect(Math.abs(minimapBox!.width - minimapSvgBox!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(minimapBox!.height - minimapSvgBox!.height)).toBeLessThanOrEqual(1);
    const minimapViewportBeforeWheel = await minimap.locator(".react-flow__minimap-mask").getAttribute("d");
    const transformBeforeWheel = await viewport.getAttribute("style");
    const flowBox = await page.locator(".cora-board-editor__flow").boundingBox();
    expect(flowBox).not.toBeNull();
    await page.mouse.move(flowBox!.x + 80, flowBox!.y + flowBox!.height - 90);
    await page.mouse.wheel(0, -420);
    await expect.poll(() => viewport.getAttribute("style")).not.toBe(transformBeforeWheel);
    await expect.poll(() =>
      minimap.locator(".react-flow__minimap-mask").getAttribute("d")
    ).not.toBe(minimapViewportBeforeWheel);
    await page.getByRole("button", { name: "Fit board", exact: true }).click();
    await page.waitForTimeout(350);

    // Movement is a persisted operation and Ctrl+Z / Ctrl+Shift+Z traverse the
    // same durable history that Cora reads.
    const requestCard = page.locator(".react-flow__node").filter({
      has: page.locator('[data-whiteboard-node="request"]'),
    });
    const requestBox = await requestCard.boundingBox();
    expect(requestBox).not.toBeNull();
    await page.mouse.move(
      requestBox!.x + requestBox!.width / 2,
      requestBox!.y + requestBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      requestBox!.x + requestBox!.width / 2 + 70,
      requestBox!.y + requestBox!.height / 2 + 25,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect.poll(async () => page.evaluate(async (runId) => {
      const run = await (window as unknown as { spark: any }).spark.orchestration.getRun(runId);
      return run?.whiteboard?.nodes?.find((node: any) => node.id === "request")?.x;
    }, created.runId)).not.toBe(80);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => page.evaluate(async (runId) => {
      const run = await (window as unknown as { spark: any }).spark.orchestration.getRun(runId);
      return run?.whiteboard?.nodes?.find((node: any) => node.id === "request")?.x;
    }, created.runId)).toBe(80);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(async () => page.evaluate(async (runId) => {
      const run = await (window as unknown as { spark: any }).spark.orchestration.getRun(runId);
      return run?.whiteboard?.nodes?.find((node: any) => node.id === "request")?.x;
    }, created.runId)).not.toBe(80);

    // A branch is an editable condition plus labeled outgoing outcomes. Users
    // can add more cases from the inspector instead of being limited to yes/no.
    await page.getByRole("button", { name: /^Branch$/ }).click();
    const kindOptions = cardInspector.getByRole("radiogroup", { name: "Card type" }).getByRole("radio");
    await expect(kindOptions).toHaveCount(9);
    const kindClasses = await kindOptions.locator("i").evaluateAll((icons) =>
      icons.map((icon) => icon.className));
    expect(new Set(kindClasses).size).toBe(9);
    const conditionCard = page.locator(".cora-board-card.kind-condition");
    await expect(conditionCard).toBeVisible();
    await expect(conditionCard).toHaveAttribute("data-node-kind", "condition");
    expect(await minimap.locator(".react-flow__minimap-node").count()).toBeGreaterThan(0);
    await expect(cardInspector.getByRole("button", { name: /Add another outcome/ })).toBeVisible();
    await cardInspector.getByRole("button", { name: /Add another outcome/ }).click();
    await expect.poll(async () => page.evaluate(async (runId) => {
      const run = await (window as unknown as { spark: any }).spark.orchestration.getRun(runId);
      const condition = run?.whiteboard?.nodes?.find((node: any) => node.kind === "condition");
      const outgoing = run?.whiteboard?.edges?.filter((edge: any) => edge.from === condition?.id) ?? [];
      return {
        hasCondition: Boolean(condition),
        labels: outgoing.map((edge: any) => edge.label).sort(),
      };
    }, created.runId)).toEqual({
      hasCondition: true,
      labels: ["Case 3", "No", "Yes"],
    });

    // A manager writing from an obsolete read is rejected rather than
    // silently overwriting the human's board.
    const staleWrite = await page.evaluate(async (runId) => {
      const spark = (window as unknown as { spark: any }).spark;
      try {
        await spark.orchestration.updateWhiteboard({
          runId,
          action: "merge",
          editor: "cora",
          baseRevision: 1,
          nodes: [],
          edges: [],
        });
        return "accepted";
      } catch (error) {
        return String((error as Error).message);
      }
    }, created.runId);
    expect(staleWrite).toContain("Whiteboard changed since revision");

    // Retaining the whiteboard must not let React Flow or backdrop-filter
    // compositor layers paint over the top-level Runs tab.
    await runsTab.click();
    await expect(runsTab).toHaveAttribute("aria-selected", "true");
    await expect(whiteboardTab).toHaveAttribute("aria-selected", "false");
    expect(await runsTab.evaluate((element) => (element as HTMLElement).style.background)).toBe("var(--accent-soft)");
    expect(await whiteboardTab.evaluate((element) => (element as HTMLElement).style.background)).toBe("transparent");
    const retainedToolbar = page.locator(".cora-board-editor__toolbar");
    await expect(retainedToolbar).toHaveCount(1);
    expect(await retainedToolbar.evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
    await expect(page.getByRole("button", { name: /Add card/ })).toHaveCount(0);
    if (process.env.CODARA_RUNS_ISOLATION_SCREENSHOT) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: process.env.CODARA_RUNS_ISOLATION_SCREENSHOT });
    }

    // Chat stays lightweight: the conversation itself begins immediately
    // beneath the normal Cora strip, with no Runs-style telemetry banner.
    await chatTab.click();
    await expect(page.locator(".cora-chat-mission-header")).toHaveCount(0);
    if (process.env.CODARA_CHAT_LIGHTWEIGHT_SCREENSHOT) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: process.env.CODARA_CHAT_LIGHTWEIGHT_SCREENSHOT });
    }
    await whiteboardTab.click();

    if (process.env.CODARA_WHITEBOARD_SCREENSHOT) {
      await page.screenshot({ path: process.env.CODARA_WHITEBOARD_SCREENSHOT });
    }

    // Whiteboard state is run-store state, not renderer-local decoration.
    // A cold renderer must recover the same board without a Cora turn.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: "Cora" }).click();
    await page.getByRole("tab", { name: "Whiteboard", exact: true }).click();
    await expect(page.getByText("Request to verified change")).toBeVisible();
    await expect(page.getByText("A persisted Cora explanation.")).toBeVisible();
    await expect(page.getByText("Human-owned insight", { exact: true })).toBeVisible();

    // Portable whiteboards are first-class repository files. Opening one from
    // Explorer selects the visual renderer rather than exposing raw JSON.
    await page.getByText("portable.coraboard", { exact: true }).click();
    await expect(page.getByText("Portable architecture", { exact: true })).toBeVisible();
    await expect(page.getByText("Portable card", { exact: true })).toBeVisible();
  } finally {
    await app?.close();
  }
});
