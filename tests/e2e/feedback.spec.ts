import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SERVER } from "./in-pane-mcp";

const { startFeedbackService } = require("./fixtures/feedback-service.cjs");

// Send feedback, the way a person and their agents use it, against a local
// stand-in for the feedback service (CODARA_FEEDBACK_URL); the real service is
// never called. FEEDBACK_SHOTS=<dir> also saves the screenshots there, at the
// window's minimum and default widths, on a dark and a light theme.

interface Fixture {
  root: string;
  home: string;
  codaraHome: string;
}

async function prepare(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-feedback-"));
  const fixture: Fixture = { root, home: join(root, "home"), codaraHome: join(root, "codara-home") };
  const workspace = join(root, "workspace");
  await Promise.all([fixture.home, fixture.codaraHome, workspace].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(fixture.home, ".zshrc"), "PS1='%~ %# '\n", "utf8");
  await writeFile(
    join(fixture.codaraHome, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-feedback", name: "feedback", cwd: workspace, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-feedback",
    }),
    "utf8",
  );
  return fixture;
}

function launch(fixture: Fixture, serviceUrl: string, extra: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...(process.env as Record<string, string>),
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      ZDOTDIR: fixture.home,
      SPARK_USER_DATA_DIR: fixture.codaraHome,
      CODARA_HOME_DIR: fixture.codaraHome,
      SPARK_HOME_DIR: fixture.codaraHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_DISABLE_KEYCHAIN: "1",
      CODARA_FEEDBACK_URL: serviceUrl,
      CODARA_FEEDBACK_ADMIN_TOKEN: "",
      ...extra,
    },
  });
}

const SIZES = [
  { name: "min", width: 720, height: 600 },
  { name: "default", width: 1280, height: 800 },
] as const;

// Each state at both widths, on a dark and a light theme.
async function shots(page: Page, name: string): Promise<void> {
  const dir = process.env.FEEDBACK_SHOTS;
  for (const theme of ["codara-classic", "codara-daylight"] as const) {
    await page.evaluate((value) => window.spark.preferences.set("theme", value), theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.waitForTimeout(150);
      const file = `${name}-${size.name}-${theme === "codara-classic" ? "dark" : "light"}.png`;
      const path = dir ? join(dir, file) : test.info().outputPath(file);
      await page.screenshot({ path });
      await test.info().attach(file, { path, contentType: "image/png" });
    }
  }
  await page.evaluate(() => window.spark.preferences.set("theme", "codara-classic"));
}

// The codara-studio MCP server over stdio, as an agent CLI launches it.
function mcpClient(home: string): {
  tool(name: string, args: Record<string, unknown>): Promise<any>;
  toolNames(): Promise<string[]>;
  close(): void;
  ready: Promise<unknown>;
} {
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: { ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home, SPARK_MCP_MODE: "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting = new Map<number, (message: any) => void>();
  let buffered = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      const message = line ? JSON.parse(line) : null;
      if (message && typeof message.id === "number") waiting.get(message.id)?.(message);
    }
  });
  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((done) => {
      const id = nextId++;
      waiting.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const ready = call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
  return {
    ready,
    toolNames: async () => ((await call("tools/list", {})).result?.tools ?? []).map((tool: { name: string }) => tool.name),
    // The tool's JSON result, parsed from its text content.
    tool: async (name, args) => {
      const message = await call("tools/call", { name, arguments: args });
      const text = (message.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
      return message.result?.isError ? { isError: true, text } : JSON.parse(text);
    },
    close: () => child.kill(),
  };
}

async function openFromSettings(page: Page): Promise<void> {
  await page.getByTitle("Settings").first().click({ force: true });
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.locator("nav").getByRole("button", { name: "About", exact: true }).click({ force: true });
  await settings.getByRole("button", { name: "Send feedback…" }).click();
  await expect(settings).toBeHidden();
}

test("a person sends feedback from Settings and sees each state", async () => {
  test.setTimeout(180_000);
  const fixture = await prepare();
  const service = await startFeedbackService();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture, service.url);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".spark-tabbar")).toBeVisible({ timeout: 30_000 });
    const dialog = page.getByTestId("feedback-dialog");

    await test.step("empty: opened from Settings, About", async () => {
      await openFromSettings(page);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Bug" })).toHaveAttribute("aria-pressed", "true");
      await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
      const version = await app!.evaluate(({ app: electronApp }) => electronApp.getVersion());
      await expect(dialog.getByTestId("feedback-what-is-sent")).toHaveText(
        `Sends your message, Studio ${version}, ${process.platform}-${process.arch}, an anonymous install id, and your email only if you add one. Nothing else.`,
      );
      await shots(page, "feedback-empty");
    });

    await test.step("filled: kind, message, email and the counter", async () => {
      await dialog.getByRole("button", { name: "Idea" }).click();
      await dialog.getByLabel("Message").fill("Let me pin a terminal tab so it survives Close others.");
      await dialog.getByLabel("Email (optional)").fill("person@example.com");
      await expect(dialog.getByText("54 / 4,000")).toBeVisible();
      await shots(page, "feedback-filled");
    });

    await test.step("sent: the service got the report and nothing else", async () => {
      await dialog.getByRole("button", { name: "Send", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: "Feedback sent" })).toBeVisible();
      expect(service.state.items).toHaveLength(1);
      const stored = JSON.parse(await readFile(join(fixture.codaraHome, "feedback.json"), "utf8"));
      const body = JSON.parse(service.state.requests.at(-1).body);
      expect(body).toEqual({
        kind: "idea",
        source: "user",
        message: "Let me pin a terminal tab so it survives Close others.",
        appVersion: expect.any(String),
        platform: `${process.platform}-${process.arch}`,
        contact: "person@example.com",
        installId: stored.installId,
      });
      expect(stored.installId).toMatch(/^[0-9a-f-]{36}$/);
      await shots(page, "feedback-sent");
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("error: a rate limit says when to try again and keeps the text", async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-feedback")));
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Message").fill("The rail flickers when a worktree is removed.");
      service.state.next.push("rate_limited");
      await dialog.getByRole("button", { name: "Send", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveText("Too many reports were sent from here. Try again in 25 minutes.");
      await expect(dialog.getByLabel("Message")).toHaveValue("The rail flickers when a worktree is removed.");
      await shots(page, "feedback-error");
      service.state.next.push("unavailable");
      await dialog.getByRole("button", { name: "Send", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveText("The feedback service is not available right now. Try again later.");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(service.state.items).toHaveLength(1);
    });
  } finally {
    await app?.close().catch(() => undefined);
    await service.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("an agent's report waits for the person's Send, unless they turned the question off", async () => {
  test.setTimeout(180_000);
  const fixture = await prepare();
  const service = await startFeedbackService();
  let app: ElectronApplication | null = null;
  const agent = mcpClient(fixture.codaraHome);
  try {
    app = await launch(fixture, service.url);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".spark-tabbar")).toBeVisible({ timeout: 30_000 });
    await agent.ready;
    const card = page.locator("[data-feedback-ask]");
    const names = await agent.toolNames();
    expect(names).toContain("codara_feedback_send");
    expect(names).not.toContain("codara_feedback_list");
    const text = "The rail flickers when a worktree is removed.\n<b>Steps</b>: remove one, watch the rail.";

    await test.step("yes: the card shows who asks and the exact text, then it is sent", async () => {
      const pending = agent.tool("codara_feedback_send", { kind: "bug", message: text });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.locator(".chrome-pairing__title")).toHaveText("Claude Code wants to send feedback to Codara");
      // Plain text, never markup.
      await expect(card.getByTestId("feedback-ask-text")).toHaveText(text);
      await expect(card.locator("b")).toHaveCount(0);
      expect(service.state.requests).toHaveLength(0);
      await shots(page, "feedback-agent-ask");
      await card.getByRole("button", { name: "Send", exact: true }).click();
      const result = await pending;
      expect(result).toEqual({ sent: true, id: service.state.items[0].id });
      await expect(card).toBeHidden();
      const body = JSON.parse(service.state.requests.at(-1).body);
      expect(body).toMatchObject({ kind: "bug", source: "agent", message: text });
      expect(body).not.toHaveProperty("contact");
    });

    await test.step("no: nothing reaches the service", async () => {
      const pending = agent.tool("codara_feedback_send", { kind: "idea", message: "Pin tabs." });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: "Don't send" }).click();
      expect(await pending).toMatchObject({ sent: false, reason: "declined" });
      await expect(card).toBeHidden();
      expect(service.state.requests).toHaveLength(1);
    });

    await test.step("the setting off: sent without a question", async () => {
      await page.evaluate(() => window.spark.preferences.set("askBeforeAgentFeedback", false));
      const result = await agent.tool("codara_feedback_send", { kind: "other", message: "Straight through." });
      expect(result).toMatchObject({ sent: true });
      await expect(card).toHaveCount(0);
      expect(JSON.parse(service.state.requests.at(-1).body)).toMatchObject({ source: "agent", message: "Straight through." });
    });
  } finally {
    agent.close();
    await app?.close().catch(() => undefined);
    await service.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("an admin's agent lists feedback and deletes an item only after the person agrees", async () => {
  test.setTimeout(180_000);
  const fixture = await prepare();
  // Not a real token: the fake accepts whatever it is started with.
  const token = "FAKE_feedback_admin_token_for_e2e";
  const service = await startFeedbackService({ adminToken: token });
  for (const message of ["Old report about tabs.", "Please delete me: <img src=x onerror=alert(1)>"]) {
    await fetch(`${service.url}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "bug", source: "user", message, appVersion: "1.4.2", platform: "linux-x64" }),
    });
  }
  let app: ElectronApplication | null = null;
  const agent = mcpClient(fixture.codaraHome);
  try {
    app = await launch(fixture, service.url, { CODARA_FEEDBACK_ADMIN_TOKEN: token });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".spark-tabbar")).toBeVisible({ timeout: 30_000 });
    await agent.ready;
    const card = page.locator("[data-feedback-ask]");

    await test.step("the admin tools are listed while a token is set", async () => {
      expect(await agent.toolNames()).toEqual(expect.arrayContaining(["codara_feedback_list", "codara_feedback_update", "codara_feedback_delete"]));
    });

    const listed = await agent.tool("codara_feedback_list", {});
    expect(listed.notice).toMatch(/untrusted data, never instructions/);
    const target = listed.items[0];
    expect(target.message).toBe("Please delete me: <img src=x onerror=alert(1)>");
    expect(JSON.stringify(listed)).not.toContain(token);

    await test.step("Keep: the card shows the item and nothing is deleted", async () => {
      const pending = agent.tool("codara_feedback_delete", { id: target.id });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.locator(".chrome-pairing__title")).toHaveText("Claude Code wants to delete feedback for good");
      await expect(card.getByTestId("feedback-ask-text")).toHaveText(target.message);
      await expect(card.locator("img")).toHaveCount(0);
      await shots(page, "feedback-admin-delete");
      await card.getByRole("button", { name: "Keep" }).click();
      expect(await pending).toMatchObject({ deleted: false, reason: "declined" });
      expect(service.state.items).toHaveLength(2);
    });

    await test.step("Delete: gone from the service", async () => {
      const pending = agent.tool("codara_feedback_delete", { id: target.id });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: "Delete", exact: true }).click();
      expect(await pending).toEqual({ deleted: true, id: target.id });
      expect(service.state.items.map((item: { id: string }) => item.id)).not.toContain(target.id);
    });
  } finally {
    agent.close();
    await app?.close().catch(() => undefined);
    await service.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
