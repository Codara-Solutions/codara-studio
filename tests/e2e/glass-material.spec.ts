import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The rules the liquid glass material must keep everywhere it reaches:
//   - one level of glass: nothing that frosts its backdrop sits inside
//     another element that does
//   - terminals stay opaque, and nothing frosts over them
//   - the Liquid glass setting and the OS reduced-transparency setting each
//     remove every backdrop filter, pseudo-elements included
//   - toggling glass is paint only: nothing on screen moves
// It drives the real renderer in a temp Codara home, with a terminal, a
// Cora chat scrolled under its header, Settings and the notification center.

test("glass is one level deep, never over a terminal, fully off when asked, and moves nothing", async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), "codara-glass-material-"));
  let app: ElectronApplication | null = null;
  try {
    const fixture = await prepareFixture(root);
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.glass)).toBe("on");

    await page.getByRole("tab", { name: /terminals/i }).first().dispatchEvent("click");
    await expect(page.locator(".spark-terminal-pane:visible").first()).toBeVisible({ timeout: 20_000 });
    const terminal = await terminalSurfaces(page);
    expect(terminal.panes).toBeGreaterThan(0);
    expect(terminal.translucent, "terminal pane backgrounds").toEqual([]);
    expect(terminal.frostedAncestors, "backdrop filters around a terminal").toEqual([]);

    await openSeededChat(page, fixture.workspaceDir);
    // Scrolled, the conversation passes under the header's frosted edge.
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
      if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 300);
    });
    await expect(page.locator('.spark-scroll-under[data-scrolled="true"]').first()).toBeAttached();
    await expect(page.locator(".cora-jump-latest")).toBeVisible();

    const onLayout = await layout(page);
    const onFilters = await backdropFilters(page);
    expect(onFilters.length, "glass on frosts something").toBeGreaterThan(0);
    expect(nested(onFilters), "glass inside glass in the chat").toEqual([]);

    // Off through the real preference: every filter goes and nothing moves.
    await setGlass(page, false);
    expect(await backdropFilters(page), "backdrop filters with glass off").toEqual([]);
    expect(await layout(page)).toEqual(onLayout);
    await setGlass(page, true);
    expect(await layout(page)).toEqual(onLayout);

    // Reduced transparency wins over the preference.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches)).toBe(true);
    expect(await backdropFilters(page), "backdrop filters under reduced transparency").toEqual([]);
    expect(await layout(page)).toEqual(onLayout);
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await cdp.detach();

    // The composer is glass, so the model menu it opens must not frost
    // inside it.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-model-picker")));
    await expect(page.locator(".spark-menu, [role='menu'], [role='listbox']").first()).toBeVisible();
    expect(nested(await backdropFilters(page)), "glass inside glass with the model menu open").toEqual([]);
    await page.keyboard.press("Escape");

    // A compact window floats the rails over the workbench as glass sheets;
    // a scrolled list inside one must not frost again.
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.getByTitle("Toggle workspaces").first().click({ force: true });
    await expect(page.locator('[data-responsive-panel="left"]')).toBeVisible();
    await page.locator(".spark-workspace-list").first().evaluate((node) => {
      node.dataset.scrolled = "true";
    });
    expect(nested(await backdropFilters(page)), "glass inside glass in the overlay rail").toEqual([]);
    await page.getByTitle("Workspace actions").first().click({ force: true });
    await expect(page.getByRole("menu").first()).toBeVisible();
    expect(nested(await backdropFilters(page)), "glass inside glass with a rail menu open").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByTitle("Toggle workspaces").first().click({ force: true });
    await expect(page.locator('[data-responsive-panel="left"]')).toHaveCount(0);
    await page.setViewportSize({ width: 1400, height: 900 });

    await page.locator('button[title="Notifications"]').first().click({ force: true });
    await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
    expect(nested(await backdropFilters(page)), "glass inside glass in the notification center").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Notifications" })).toHaveCount(0);

    await page.getByTitle("Settings").first().click({ force: true });
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.locator(".st-content").first().evaluate((node) => node.scrollTo(0, 400));
    expect(nested(await backdropFilters(page)), "glass inside glass in Settings").toEqual([]);
    await setGlass(page, false);
    expect(await backdropFilters(page), "backdrop filters in Settings with glass off").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

interface Frosted {
  /** A short CSS path to the element, with ::before / ::after for a pseudo. */
  path: string;
  /** The nearest frosted ancestor's path, or null. */
  inside: string | null;
}

function nested(filters: Frosted[]): string[] {
  return filters.filter((f) => f.inside).map((f) => `${f.path} inside ${f.inside}`);
}

// Every element and pseudo-element painting a backdrop filter. A pseudo
// counts as inside its own element when that element frosts too.
async function backdropFilters(page: Page): Promise<Frosted[]> {
  return page.evaluate(() => {
    const frosts = (style: CSSStyleDeclaration) => {
      const value =
        style.backdropFilter ||
        (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter ||
        "none";
      return value !== "none" && value !== "";
    };
    const pathOf = (el: Element) => {
      const parts: string[] = [];
      for (let node: Element | null = el; node && parts.length < 3; node = node.parentElement) {
        const cls = Array.from(node.classList).slice(0, 2).join(".");
        parts.unshift(cls ? `${node.tagName.toLowerCase()}.${cls}` : node.tagName.toLowerCase());
      }
      return parts.join(" > ");
    };
    const out: { path: string; inside: string | null }[] = [];
    // An ancestor's own ::before / ::after frost sits under its children, so
    // it counts as an outer layer too.
    const frostedPseudo = (node: Element) =>
      (["::before", "::after"] as const).find((pseudo) => {
        const style = getComputedStyle(node, pseudo);
        return style.content !== "none" && style.content !== "normal" && frosts(style);
      });
    const frostedAncestor = (el: Element | null, skipPseudoOf?: Element): string | null => {
      for (let node = el; node; node = node.parentElement) {
        if (frosts(getComputedStyle(node))) return pathOf(node);
        const pseudo = node === skipPseudoOf ? undefined : frostedPseudo(node);
        if (pseudo) return `${pathOf(node)}${pseudo}`;
      }
      return null;
    };
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (frosts(getComputedStyle(el))) out.push({ path: pathOf(el), inside: frostedAncestor(el.parentElement) });
      for (const pseudo of ["::before", "::after"] as const) {
        const style = getComputedStyle(el, pseudo);
        if (style.content === "none" || style.content === "normal") continue;
        if (frosts(style)) {
          out.push({ path: `${pathOf(el)}${pseudo}`, inside: frostedAncestor(el, el) ?? null });
        }
      }
    }
    return out;
  });
}

// The boxes that would move if glass changed layout: the frame bands, the
// rails, the chat's header, first rows, jump button and composer.
async function layout(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const selectors = [
      ".spark-titlebar",
      ".spark-statusbar",
      ".spark-rail",
      ".spark-section-header",
      ".spark-workspace-list",
      ".spark-resize-gutter",
      "[data-message-author]",
      ".cora-jump-latest",
      ".composer-shell",
      ".spark-terminal-pane",
    ];
    const out: Record<string, string[]> = {};
    for (const selector of selectors) {
      out[selector] = Array.from(document.querySelectorAll(selector))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .slice(0, 6)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
        });
    }
    return out;
  });
}

async function terminalSurfaces(page: Page) {
  return page.evaluate(() => {
    const alpha = (color: string) => {
      const slash = color.match(/\/\s*([\d.]+%?)\s*\)$/);
      if (slash) return slash[1].endsWith("%") ? Number.parseFloat(slash[1]) / 100 : Number(slash[1]);
      const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
      return rgba ? Number(rgba[1]) : 1;
    };
    const panes = Array.from(document.querySelectorAll<HTMLElement>(".spark-terminal-pane")).filter(
      (el) => el.offsetParent !== null,
    );
    const translucent: string[] = [];
    const frostedAncestors: string[] = [];
    for (const pane of panes) {
      const bg = getComputedStyle(pane).backgroundColor;
      if (alpha(bg) < 1) translucent.push(bg);
      for (let node: HTMLElement | null = pane; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        const filter =
          style.backdropFilter ||
          (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter ||
          "none";
        if (filter !== "none" && filter !== "") frostedAncestors.push(node.className);
      }
      // Anything frosted that overlaps the pane would sample the terminal.
      const box = pane.getBoundingClientRect();
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
        if (pane.contains(el) || el.contains(pane)) continue;
        const style = getComputedStyle(el);
        const filter = style.backdropFilter || "none";
        if (filter === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const r = el.getBoundingClientRect();
        if (r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom) {
          frostedAncestors.push(`over: ${el.className}`);
        }
      }
      for (const el of Array.from(pane.querySelectorAll<HTMLElement>("*"))) {
        const style = getComputedStyle(el);
        const filter = style.backdropFilter || "none";
        if (filter !== "none" && style.opacity !== "0") frostedAncestors.push(`in: ${el.className}`);
      }
    }
    return { panes: panes.length, translucent, frostedAncestors };
  });
}

async function setGlass(page: Page, on: boolean): Promise<void> {
  await page.evaluate((value) => window.spark.preferences.set("glassEffects", value), on);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.glass)).toBe(on ? "on" : "off");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openSeededChat(page: Page, cwd: string): Promise<void> {
  await page.evaluate(async (workspaceCwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.createRun({
      workspaceId: "ws-glass",
      workspaceName: "glass",
      cwd: workspaceCwd,
      title: "Glass material",
    });
    for (let index = 1; index <= 14; index += 1) {
      await spark.orchestration.addRunMessage({
        runId: run.id,
        author: index % 2 ? "user" : "spark",
        kind: "note",
        message: `Turn ${index}. A paragraph long enough to wrap onto a second line in the chat column, so the conversation scrolls well past its header and its composer.`,
      });
    }
  }, cwd);
  const tab = page.getByRole("tab", { name: /New chat/ }).first();
  await expect(tab).toBeAttached({ timeout: 15_000 });
  await tab.dispatchEvent("click");
  await page.getByRole("button", { name: "Open chat history" }).last().dispatchEvent("click");
  await page.getByRole("option").filter({ hasText: "Glass material" }).first().dispatchEvent("click");
  await expect(page.locator("[data-message-author]").last()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.cora-chat-panel[data-composer-float="true"]')).toBeAttached();
}

async function prepareFixture(root: string) {
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# glass\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-glass", name: "glass", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
      activeWorkspaceId: "ws-glass",
    }),
    "utf8",
  );
  await writeFile(
    join(userDataDir, "spark-preferences.json"),
    JSON.stringify({ theme: "codara-classic", glassEffects: true }),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}

async function launch({ userDataDir }: { userDataDir: string }): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
}
