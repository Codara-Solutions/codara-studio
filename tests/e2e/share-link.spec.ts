import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Share as link, end to end against a real codara-share service on loopback:
// a Markdown file with a local picture, a table and a Mermaid diagram is
// shared from the editor toolbar, the served page is fetched and checked, the
// link lands on the clipboard, Settings lists, extends and deletes it, and an
// agent's codara_share_offer only opens the prompt (nothing is uploaded when
// the user cancels), and a picture that is a link out of the workspace is
// left out, not embedded.
//
// The service is the codara-share repository built next to this one
// (npm run build there), or the one CODARA_SHARE_REPO names.

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b20000000049454e44ae426082",
  "hex",
);

function shareRepo(): string | null {
  const root = resolve(__dirname, "..", "..");
  const candidates = [process.env.CODARA_SHARE_REPO, resolve(root, "..", "codara-share")];
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    candidates.push(resolve(common, "..", "..", "codara-share"));
  } catch {
    /* not a git checkout */
  }
  return candidates.find((dir): dir is string => !!dir && existsSync(join(dir, "dist", "src", "main.js"))) ?? null;
}

async function startShareService(repo: string, storageDir: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, [join(repo, "dist", "src", "main.js")], {
    env: {
      PATH: process.env.PATH,
      HOST: "127.0.0.1",
      PORT: "0",
      STORAGE_BACKEND: "local",
      LOCAL_STORAGE_DIR: storageDir,
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`share service did not start: ${buffered}`)), 15_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (const line of buffered.split("\n")) {
        try {
          const event = JSON.parse(line) as { event?: string; port?: number };
          if (event.event === "share_started" && typeof event.port === "number") {
            clearTimeout(timer);
            resolvePort(event.port);
          }
        } catch {
          /* partial line */
        }
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`share service exited (${code}): ${buffered}`));
    });
  });
  return { child, port };
}

async function storedPages(storageDir: string): Promise<string[]> {
  const files = await readdir(join(storageDir, "pages")).catch(() => [] as string[]);
  return files.filter((name) => name.endsWith(".html"));
}

test("a page is shared from the editor, served sealed, managed in Settings, and an agent can only offer it", async () => {
  test.setTimeout(180_000);
  const repo = shareRepo();
  test.skip(!repo, "codara-share is not built next to this repository (set CODARA_SHARE_REPO)");

  const root = await mkdtemp(join(tmpdir(), "codara-share-link-"));
  const home = join(root, "home");
  const workspaceDir = join(root, "workspace");
  const storageDir = join(root, "share-store");
  await mkdir(home, { recursive: true });
  await mkdir(join(workspaceDir, "img"), { recursive: true });
  await writeFile(join(workspaceDir, "img", "chart.png"), PNG);
  await writeFile(
    join(workspaceDir, "report.md"),
    [
      "# Quarterly report",
      "",
      "| Region | Total |",
      "|---|---|",
      "| North | 42 |",
      "",
      "![chart](img/chart.png)",
      "",
      "```mermaid",
      "graph TD; Plan-->Ship",
      "```",
      "",
      "<script>window.leaked = true</script>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspaceDir, "page.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Agent page</h1><img src="img/chart.png"><img src="img/escape.png"></body></html>',
    "utf8",
  );
  // A picture name that is a link to a file outside the workspace. Windows
  // needs extra rights to make links; there the reference is simply missing.
  await writeFile(join(root, "outside-secret.png"), "PRIVATE KEY", "utf8");
  if (process.platform !== "win32") await symlink(join(root, "outside-secret.png"), join(workspaceDir, "img", "escape.png"));
  await writeFile(join(workspaceDir, "style.css"), "h1 { color: rgb(1, 2, 3); }", "utf8");
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-share", name: "share-fixture", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
      activeWorkspaceId: "ws-share",
    }),
    "utf8",
  );

  const service = await startShareService(repo!, storageDir);
  const base = `http://127.0.0.1:${service.port}`;
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: home,
        CODARA_HOME_DIR: home,
        SPARK_HOME_DIR: home,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        CODARA_SHARE_URL: base,
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForLoadState("domcontentloaded");

    // Share the Markdown file from its toolbar.
    const reportPath = join(workspaceDir, "report.md");
    const fileRow = page.locator(`[data-fs-path="${reportPath.replace(/\\/g, "\\\\")}"]`);
    await expect(fileRow).toBeVisible({ timeout: 20_000 });
    await fileRow.dispatchEvent("click");
    await expect(page.getByRole("tab", { name: "report.md" })).toBeVisible();
    await page.getByRole("button", { name: "Share as link" }).click();
    const prompt = page.getByRole("dialog", { name: "Share as link" });
    await expect(prompt.getByText("Anyone with the link can open this page.")).toBeVisible({ timeout: 20_000 });
    await expect(prompt.getByText("Includes 1 file from this computer.")).toBeVisible();
    expect(await storedPages(storageDir), "nothing is uploaded before Share").toEqual([]);
    await prompt.getByRole("radio", { name: "7 days" }).click();
    await prompt.getByRole("button", { name: "Share", exact: true }).click();
    await expect(prompt.getByText("Link copied.")).toBeVisible({ timeout: 20_000 });
    const link = await prompt.getByRole("textbox", { name: "Shared link" }).inputValue();
    expect(link).toMatch(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/p/[A-Za-z0-9_-]{24}$`));
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(link);

    // The served page is the whole report, self-contained and sealed.
    const served = await fetch(link);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy") ?? "").toContain("sandbox");
    expect(served.headers.get("content-security-policy") ?? "").toContain("connect-src 'none'");
    expect(served.headers.get("x-robots-tag") ?? "").toContain("noindex");
    const body = await served.text();
    expect(body).toContain("<h1>Quarterly report</h1>");
    expect(body).toContain("<td>42</td>");
    expect(body).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(body).toContain('<div class="diagram"><svg');
    expect(body).not.toContain("window.leaked");
    expect(body).not.toContain("file://");
    expect(body).not.toContain(workspaceDir);
    expect(await storedPages(storageDir)).toHaveLength(1);

    // The share key lives in the Codara home, owner-only.
    if (process.platform !== "win32") {
      expect((await stat(join(home, "share", "identity.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "share"))).mode & 0o777).toBe(0o700);
    }
    await prompt.getByRole("button", { name: "Done" }).click();
    await expect(prompt).toHaveCount(0);

    // Settings lists the link; extend it, then delete it.
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("spark:open-settings", { detail: { section: "shared-pages" } })),
    );
    const row = page.locator("[data-shared-page]");
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row).toContainText("report.md");
    await expect(row).toContainText(link);
    await row.getByRole("button", { name: "Expiry" }).click();
    await page.getByRole("option", { name: "Expire 90 days from today" }).click();
    await expect(row.getByRole("button", { name: "Expiry" })).toBeEnabled();
    const meta = JSON.parse(
      await readFile(join(storageDir, "pages", `${link.split("/").pop()}.json`), "utf8"),
    ) as { expiresAt: number };
    expect(meta.expiresAt - Date.now()).toBeGreaterThan(89 * 86_400_000);
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await row.getByRole("button", { name: "Delete link" }).click();
    await expect(page.getByText("No shared pages.")).toBeVisible({ timeout: 15_000 });
    expect((await fetch(link)).status).toBe(404);
    expect(await storedPages(storageDir)).toEqual([]);
    await page.keyboard.press("Escape");

    // An agent's offer opens the file and its prompt, and uploads nothing.
    const handshakeFile = join(home, "agent-socket.json");
    await expect
      .poll(async () => (await readFile(handshakeFile, "utf8").catch(() => "")).length > 0, { timeout: 20_000 })
      .toBe(true);
    const { url, token } = JSON.parse(await readFile(handshakeFile, "utf8")) as { url: string; token: string };
    const offer = async (path: string) => {
      const response = await fetch(`${url}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "share.offer", params: { path, callerPid: process.pid } }),
      });
      return (await response.json()) as { result?: { offered?: boolean; reason?: string }; error?: { message: string } };
    };
    const refused = await offer(join(root, "home", "spark-state.json"));
    expect(refused.result?.offered).toBe(false);
    const offered = await offer(join(workspaceDir, "page.html"));
    expect(offered.error?.message, "share.offer").toBeUndefined();
    expect(offered.result?.offered).toBe(true);
    await expect(page.getByRole("tab", { name: "page.html" })).toBeVisible({ timeout: 15_000 });
    const offerPrompt = page.getByRole("dialog", { name: "Share as link" });
    await expect(offerPrompt.getByText("Anyone with the link can open this page.")).toBeVisible({ timeout: 20_000 });
    await expect(offerPrompt.getByText("Includes 2 files from this computer.")).toBeVisible();
    await offerPrompt.getByText("Left out 1 file.").click();
    await expect(offerPrompt.getByText(process.platform === "win32" ? "img/escape.png (could not be read)" : "img/escape.png (outside this folder)")).toBeVisible();
    await offerPrompt.getByRole("button", { name: "Cancel" }).click();
    await expect(offerPrompt).toHaveCount(0);
    expect(await storedPages(storageDir), "an offer the user cancels uploads nothing").toEqual([]);
  } finally {
    await app?.close();
    service.child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
