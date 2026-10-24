import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// The overlay a pane opens with `codara-pane overlay` (the /sessions picker
// over a Claude Code pane) has to hold up the way the user moves around:
// leaving the workspace and coming back must leave the keyboard in it,
// splitting the pane underneath must keep it over that pane's cell only,
// the keys typed must reach the overlay while it is open and the pane once
// it closes, an overlay opening or closing while the user is in another cell
// must leave the keyboard there, and closing the pane underneath must end the
// overlay's program.

function waitFor(signals: string, name: string): string {
  return `while [ ! -f ${JSON.stringify(join(signals, name))} ]; do sleep 0.2; done`;
}

async function fileText(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

function modKey(key: string): string {
  return `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;
}

async function keyboardOwner(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const overlay = active?.closest("[data-pane-overlay-id]");
    if (overlay) return `overlay:${overlay.getAttribute("data-pane-overlay-host")}`;
    const pane = active?.closest("[data-terminal-pane-id]");
    return pane ? `pane:${pane.getAttribute("data-terminal-pane-id")}` : "none";
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a pane overlay keeps the keyboard across workspaces and splits and ends with its pane", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-pane-overlay-layouts-"));
  const home = join(root, "home");
  const signals = join(root, "signals");
  const cwdA = join(root, "a");
  const cwdB = join(root, "b");
  await Promise.all([mkdir(home), mkdir(signals), mkdir(cwdA), mkdir(cwdB)]);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [
        { id: "ws-a", name: "Workspace A", cwd: cwdA, color: "#42D6C7", workers: [] },
        { id: "ws-b", name: "Workspace B", cwd: cwdB, color: "#D6A742", workers: [] },
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

    const overlayGot = join(signals, "overlay-got");
    const hostGot = join(signals, "host-got");
    const secondPid = join(signals, "second-pid");
    const overlayScript = join(signals, "overlay.sh");
    const elsewhereScript = join(signals, "elsewhere.sh");
    const secondScript = join(signals, "second.sh");
    await writeFile(
      overlayScript,
      `echo OVERLAY-UP; read first; printf '%s' "$first" > ${JSON.stringify(overlayGot)}; ${waitFor(signals, "close")}\n`,
    );
    await writeFile(elsewhereScript, `echo ELSEWHERE-UP; ${waitFor(signals, "close-elsewhere")}\n`);
    await writeFile(secondScript, `echo $$ > ${JSON.stringify(secondPid)}; ${waitFor(signals, "never")}\n`);
    const callerScript = [
      waitFor(signals, "open"),
      `codara-pane overlay -- sh ${JSON.stringify(overlayScript)}`,
      "read back",
      `printf '%s' "$back" > ${JSON.stringify(hostGot)}`,
      waitFor(signals, "elsewhere"),
      `codara-pane overlay -- sh ${JSON.stringify(elsewhereScript)}`,
      waitFor(signals, "again"),
      `codara-pane overlay -- sh ${JSON.stringify(secondScript)}`,
    ].join("; ");
    const caller = (await request("terminal.create", { cwd: cwdA, title: "caller", command: callerScript })) as {
      paneId: string;
    };
    await page.locator("[data-tab-id]", { hasText: "caller" }).click();
    const hostFrame = page.locator(`[data-terminal-pane-id="${caller.paneId}"]`);
    await expect(hostFrame).toBeVisible();
    await hostFrame.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expect.poll(() => keyboardOwner(page)).toBe(`pane:${caller.paneId}`);

    await writeFile(join(signals, "open"), "");
    const overlay = page.locator(`[data-pane-overlay-host="${caller.paneId}"]`);
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    const overlayId = (await overlay.getAttribute("data-pane-overlay-id"))!;
    await expect
      .poll(async () => JSON.stringify(await request("terminal.read", { paneId: overlayId })), { timeout: 15_000 })
      .toContain("OVERLAY-UP");
    await expect.poll(() => keyboardOwner(page)).toBe(`overlay:${caller.paneId}`);

    // Away to another workspace and back: the overlay is still up and still
    // has the keyboard, not the pane hidden under it.
    await page.locator('[data-workspace-id="ws-b"]').dispatchEvent("click");
    await expect(overlay).toBeHidden();
    await page.locator('[data-workspace-id="ws-a"]').dispatchEvent("click");
    await expect(overlay).toBeVisible();
    await expect.poll(() => keyboardOwner(page)).toBe(`overlay:${caller.paneId}`);
    await page.keyboard.type("typed-into-overlay");
    await page.keyboard.press("Enter");
    await expect.poll(() => fileText(overlayGot)).toBe("typed-into-overlay");

    // Split the pane under the overlay: the overlay stays over that pane's
    // cell and leaves the new neighbour uncovered.
    await page.keyboard.press(modKey("d"));
    const panes = page.locator(".spark-terminal-pane:visible");
    await expect(panes).toHaveCount(2);
    const siblingId = await page.evaluate((host) => {
      return (
        Array.from(document.querySelectorAll<HTMLElement>(".spark-terminal-pane[data-terminal-pane-id]"))
          .filter((el) => el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden")
          .map((el) => el.getAttribute("data-terminal-pane-id"))
          .find((id) => id && id !== host) ?? null
      );
    }, caller.paneId);
    expect(siblingId).toBeTruthy();
    await expect
      .poll(async () => {
        const [hostBox, overlayBox, siblingBox] = await Promise.all([
          hostFrame.boundingBox(),
          overlay.boundingBox(),
          page.locator(`[data-terminal-pane-id="${siblingId}"]`).boundingBox(),
        ]);
        if (!hostBox || !overlayBox || !siblingBox) return "unmeasured";
        const inside =
          overlayBox.x >= hostBox.x - 1 &&
          overlayBox.y >= hostBox.y - 1 &&
          overlayBox.x + overlayBox.width <= hostBox.x + hostBox.width + 1 &&
          overlayBox.y + overlayBox.height <= hostBox.y + hostBox.height + 1;
        const sameWidth = Math.abs(overlayBox.width - hostBox.width) <= 1;
        const clearOfSibling =
          overlayBox.x + overlayBox.width <= siblingBox.x + 1 || siblingBox.x + siblingBox.width <= overlayBox.x + 1;
        return inside && sameWidth && clearOfSibling ? "over the pane only" : JSON.stringify({ hostBox, overlayBox, siblingBox });
      })
      .toBe("over the pane only");

    // Back in the overlay, then its program exits: the overlay closes and
    // the pane under it takes the keyboard again.
    await overlay.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expect.poll(() => keyboardOwner(page)).toBe(`overlay:${caller.paneId}`);
    await writeFile(join(signals, "close"), "");
    await expect(overlay).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => keyboardOwner(page)).toBe(`pane:${caller.paneId}`);
    await page.keyboard.type("typed-into-host");
    await page.keyboard.press("Enter");
    await expect.poll(() => fileText(hostGot), { timeout: 10_000 }).toBe("typed-into-host");

    // The user moves into the neighbour, and the program in the other cell
    // opens an overlay and later closes it: neither moves the keyboard out of
    // the cell the focus ring marks.
    const sibling = page.locator(`[data-terminal-pane-id="${siblingId}"]`);
    await sibling.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expect.poll(() => keyboardOwner(page)).toBe(`pane:${siblingId}`);
    await writeFile(join(signals, "elsewhere"), "");
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    const elsewhereId = (await overlay.getAttribute("data-pane-overlay-id"))!;
    await expect
      .poll(async () => JSON.stringify(await request("terminal.read", { paneId: elsewhereId })), { timeout: 15_000 })
      .toContain("ELSEWHERE-UP");
    await page.waitForTimeout(500);
    expect(await keyboardOwner(page)).toBe(`pane:${siblingId}`);
    await writeFile(join(signals, "close-elsewhere"), "");
    await expect(overlay).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(500);
    expect(await keyboardOwner(page)).toBe(`pane:${siblingId}`);

    // A second overlay, then the pane underneath is closed: the overlay and
    // its program go with it.
    await writeFile(join(signals, "again"), "");
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => fileText(secondPid), { timeout: 15_000 }).toMatch(/^\d+\s*$/);
    const pid = Number((await fileText(secondPid)).trim());
    expect(processAlive(pid)).toBe(true);
    await request("terminal.close", { paneId: caller.paneId });
    await expect(overlay).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => processAlive(pid), { timeout: 15_000 }).toBe(false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
