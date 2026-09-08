import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

test("whiteboard review requires current rendered evidence and survives reload", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-whiteboard-review-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(join(cwd, "entry.ts"), 'import { save } from "./store";\nexport const submit = () => save();\n');
  await writeFile(join(cwd, "store.ts"), 'export const save = () => "saved";\n');
  await writeFile(join(home, "spark-state.json"), JSON.stringify({ activeWorkspaceId: "whiteboard-ws", workspaces: [{ id: "whiteboard-ws", name: "Whiteboard review", cwd, color: "#42D6C7", workers: [] }] }));
  const app = await electron.launch({ args: ["."], env: {
    ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const request = async (method: string, params: Record<string, unknown>) => {
    const response = await rpcRaw({ home }, `orchestrator.whiteboard_${method}`, params, { timeoutMs: 30_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await expect(page.locator('[data-workspace-id="whiteboard-ws"]')).toBeVisible();
    const runId = await page.evaluate(async (cwd) => (await window.spark.orchestration.createRun({ workspaceId: "whiteboard-ws", workspaceName: "Whiteboard review", cwd, title: "Project map" })).id, cwd);
    const first = await request("update", { runId, baseRevision: 0, title: "Submission flow", summary: "The entry point calls the persistence module.", nodes: [
      { id: "entry", kind: "file", title: "Submission entry", body: "submit delegates to save.", x: 0, y: 0, sources: ["entry.ts:2"], confidence: "confirmed" },
      { id: "store", kind: "file", title: "Persistence module", body: "save returns the saved result.", x: 10, y: 10, sources: ["store.ts:1"], confidence: "confirmed" },
    ], edges: [{ id: "save", from: "entry", to: "store", label: "calls save", sources: ["entry.ts:2"], confidence: "confirmed" }] });
    expect(first.issues.some((issue: { code: string }) => issue.code === "overlap")).toBe(true);
    await expect(request("review", { runId, baseRevision: 1, summary: "Looks fine" })).rejects.toThrow(/Inspect the current/);
    const overlap = await request("inspect", { runId, baseRevision: 1 });
    expect(overlap.issues.some((issue: { code: string }) => issue.code === "overlap")).toBe(true);
    await expect(request("review", { runId, baseRevision: 1, summary: "Reviewed" })).rejects.toThrow(/Fix the whiteboard issues/);
    const arranged = await request("arrange", { runId, baseRevision: 1 });
    expect(arranged.whiteboard.revision).toBe(2);
    const inspected = await request("inspect", { runId, baseRevision: 2 });
    expect(inspected.issues).toEqual([]);
    expect(inspected.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(inspected.imageSize.width).toBeGreaterThan(600);
    await writeFile(testInfo.outputPath("reviewed-whiteboard.png"), Buffer.from(inspected.dataUrl.split(",")[1], "base64"));
    const reviewed = await request("review", { runId, baseRevision: 2, summary: "Checked both source files, call direction, readable labels, and spacing." });
    expect(reviewed.whiteboard.review.revision).toBe(2);
    await page.locator(`[data-tab-id="${runId}"]`).click();
    await page.getByRole("tab", { name: "Whiteboard", exact: true }).click();
    await expect(page.getByText("Cora reviewed", { exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => {
      const canvas = document.querySelector('.cora-whiteboard-surface__canvas .react-flow')!.getBoundingClientRect();
      return Array.from(document.querySelectorAll('.cora-whiteboard-surface__canvas [data-whiteboard-node]')).every((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= canvas.left && rect.right <= canvas.right && rect.top >= canvas.top && rect.bottom <= canvas.bottom;
      });
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("whiteboard-ui.png") });
    await page.reload();
    expect((await request("get", { runId })).whiteboard.review.revision).toBe(2);
    await page.evaluate(async (runId) => {
      await window.spark.orchestration.updateWhiteboard({ runId, action: "merge", editor: "user", baseRevision: 2, nodes: [{ id: "store", title: "Human edit" }], edges: [{ id: "save", label: "calls save()" }] });
    }, runId);
    const changed = await request("get", { runId });
    expect(changed.whiteboard.review).toBeUndefined();
    expect(changed.whiteboard.nodes.find((node: { id: string }) => node.id === "store").sources).toEqual(["store.ts:1"]);
    expect(changed.whiteboard.edges[0]).toMatchObject({ from: "entry", to: "store", label: "calls save()", sources: ["entry.ts:2"] });
    await expect(request("review", { runId, baseRevision: 3, summary: "Old image" })).rejects.toThrow(/Inspect the current/);
    await expect(request("inspect", { runId, baseRevision: 2 })).rejects.toThrow(/Read revision 3/);
    const clipped = await request("update", { runId, action: "merge", baseRevision: 3, nodes: [{ id: "store", body: "An excessively long explanation that will not fit in this card. ".repeat(12) }] });
    const clipping = await request("inspect", { runId, baseRevision: clipped.whiteboard.revision });
    expect(clipping.issues.some((issue: { code: string }) => issue.code === "clipped-text")).toBe(true);
    const wide = await request("update", { runId, action: "merge", baseRevision: clipped.whiteboard.revision, nodes: [{ id: "store", body: "Readable detail", x: 6000 }] });
    const overview = await request("inspect", { runId, baseRevision: wide.whiteboard.revision });
    expect(overview.detailNeeded).toBe(true);
    await expect(request("review", { runId, baseRevision: wide.whiteboard.revision, summary: "Overview only" })).rejects.toThrow(/readable detail crops/);
    for (const nodeId of ["entry", "store"]) {
      const detail = await request("inspect", { runId, baseRevision: wide.whiteboard.revision, nodeIds: [nodeId] });
      expect(detail.detailNeeded).toBe(false);
    }
    expect((await request("review", { runId, baseRevision: wide.whiteboard.revision, summary: "Reviewed both readable detail crops and the connecting overview." })).whiteboard.review.revision).toBe(wide.whiteboard.revision);
    const capturing = request("inspect", { runId, baseRevision: wide.whiteboard.revision });
    const staleCapture = expect(capturing).rejects.toThrow(/changed while capturing/);
    await expect(page.locator('[aria-hidden="true"] > [data-testid="cora-whiteboard-canvas"]')).toBeAttached();
    await page.evaluate(async ({ runId, revision }) => {
      await window.spark.orchestration.updateWhiteboard({ runId, action: "merge", editor: "user", baseRevision: revision, title: "Edited during capture" });
    }, { runId, revision: wide.whiteboard.revision });
    await staleCapture;
    expect((await request("get", { runId })).whiteboard.review).toBeUndefined();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
