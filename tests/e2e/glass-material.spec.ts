import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Where liquid glass may go, and the rules it keeps there:
//   - only the layers that open above the window frost: menus, popovers,
//     the notification center, toasts, palettes and dialogs
//   - the window itself (frame, rails, headers, tabs, status bar, chat,
//     composer, terminals) looks exactly the same with glass on or off
//   - one level of glass: nothing that frosts its backdrop sits inside
//     another element that does
//   - terminals stay opaque, and nothing frosts over them
//   - the Liquid glass setting and the OS reduced-transparency setting each
//     remove every backdrop filter, pseudo-elements included
// It drives the real renderer in a temp Codara home, with a terminal, a
// scrolled Cora chat, a workspace folder in the rail, a workspace menu, the
// notification center and Settings.

test("glass is only on the layers that open above the window, one level deep, and fully off when asked", async () => {
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
    await page.locator(".spark-terminal-pane:visible").first().hover();
    expect(await backdropFilters(page), "backdrop filters on the terminal's toolbar").toEqual([]);

    await openSeededChat(page, fixture.workspaceDir);
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
      if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 300);
    });
    await expect(page.locator(".cora-jump-latest")).toBeVisible();
    await page.mouse.move(1, 450);
    await expect(page.locator(".spark-workspace-folder").first()).toBeVisible();

    // The resting window holds no glass, and glass changes none of it.
    expect(await backdropFilters(page), "backdrop filters on the resting window").toEqual([]);
    const onLook = await windowLook(page);
    await setGlass(page, false);
    expect(diffLook(onLook, await windowLook(page)), "the window with glass off").toEqual([]);
    await setGlass(page, true);

    // A menu opened from the rail is glass, and nothing under it is.
    await page.getByTitle("Workspace actions").first().click({ force: true });
    const menu = page.getByRole("menu").first();
    await expect(menu).toBeVisible();
    const withMenu = await backdropFilters(page);
    expect(withMenu.length, "the open menu frosts").toBeGreaterThan(0);
    expect(nested(withMenu), "glass inside glass with a rail menu open").toEqual([]);
    expect(await frostedOutside(page, '[role="menu"]'), "frost outside the open menu").toEqual([]);
    await setGlass(page, false);
    expect(await backdropFilters(page), "backdrop filters on a menu with glass off").toEqual([]);
    await setGlass(page, true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // Reduced transparency wins over the preference.
    await page.getByTitle("Workspace actions").first().click({ force: true });
    await expect(page.getByRole("menu").first()).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches)).toBe(true);
    expect(await backdropFilters(page), "backdrop filters under reduced transparency").toEqual([]);
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await cdp.detach();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await page.locator('button[title="Notifications"]').first().click({ force: true });
    const center = page.getByRole("dialog", { name: "Notifications" });
    await expect(center).toBeVisible();
    const withCenter = await backdropFilters(page);
    expect(withCenter.length, "the notification center frosts").toBeGreaterThan(0);
    expect(nested(withCenter), "glass inside glass in the notification center").toEqual([]);
    expect(await frostedOutside(page, ".nc-panel"), "frost outside the notification center").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(center).toHaveCount(0);

    await page.getByTitle("Settings").first().click({ force: true });
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.locator(".st-content").first().evaluate((node) => node.scrollTo(0, 400));
    const withSettings = await backdropFilters(page);
    expect(withSettings.length, "the Settings face frosts").toBeGreaterThan(0);
    expect(nested(withSettings), "glass inside glass in Settings").toEqual([]);
    expect(await frostedOutside(page, ".settings-dialog-surface"), "frost outside Settings").toEqual([]);
    // Only the nav column frosts, and at the read tier, so its labels never
    // depend on what is open behind Settings.
    const face = await settings.evaluate((node) => {
      const filter = (el: Element) => getComputedStyle(el).backdropFilter || "none";
      const nav = node.querySelector(".st-nav")!;
      const fill = getComputedStyle(nav).backgroundColor;
      const slash = fill.match(/\/\s*([\d.]+%?)\s*\)$/);
      const rgba = fill.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
      const alpha = slash
        ? slash[1].endsWith("%")
          ? Number.parseFloat(slash[1]) / 100
          : Number(slash[1])
        : rgba
          ? Number(rgba[1])
          : 1;
      return { face: filter(node), nav: filter(nav), navAlpha: alpha };
    });
    expect(face.face, "the Settings face frosts the area its opaque panes cover").toBe("none");
    expect(face.nav, "the Settings nav frosts").not.toBe("none");
    expect(face.navAlpha, "the Settings nav tint").toBeGreaterThanOrEqual(0.85);
    const pane = await settings.locator(".st-content").first().evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(pane, "the Settings reading pane is opaque").not.toMatch(/\/\s*0?\.\d+\)$|rgba\(/);
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

// How every visible element of the window paints. Glass must change none of
// it while nothing is open over the window.
async function windowLook(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const pathOf = (el: Element) => {
      const parts: string[] = [];
      for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
        const parent = node.parentElement;
        const index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0;
        parts.unshift(`${node.tagName.toLowerCase()}${index}`);
      }
      return parts.join(">");
    };
    const out: Record<string, string> = {};
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      if (el.closest(".xterm")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") continue;
      out[pathOf(el)] = [
        el.className && typeof el.className === "string" ? el.className.split(" ").slice(0, 2).join(".") : "",
        cs.backgroundColor,
        cs.backgroundImage,
        cs.boxShadow,
        cs.borderTopColor,
        cs.color,
        cs.backdropFilter,
      ].join(" | ");
    }
    return out;
  });
}

function diffLook(a: Record<string, string>, b: Record<string, string>): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] !== b[key]) out.push(`${a[key] ?? "(missing)"}  =>  ${b[key] ?? "(missing)"}`);
  }
  return out.slice(0, 20);
}

// Frosted elements that are not inside the open layer.
async function frostedOutside(page: Page, layer: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      const filter = cs.backdropFilter || "none";
      if (filter === "none" || filter === "") continue;
      if (el.closest(selector) || el.querySelector(selector)) continue;
      out.push(`${el.tagName.toLowerCase()}.${Array.from(el.classList).slice(0, 2).join(".")}`);
    }
    return out;
  }, layer);
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
}

async function prepareFixture(root: string) {
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const filedDir = join(root, "filed");
  await mkdir(filedDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# glass\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws-glass", name: "glass", cwd: workspaceDir, color: "#42D6C7", workers: [] },
        { id: "ws-filed", name: "filed", cwd: filedDir, color: "#D6A742", workers: [], groupId: "group-glass" },
      ],
      workspaceGroups: [{ id: "group-glass", name: "Folder", collapsed: false, color: "#D6A742" }],
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
