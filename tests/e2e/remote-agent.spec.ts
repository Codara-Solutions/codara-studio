import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Agents on an SSH machine (Machines phase 1, src/main/remote/remote-agents.ts)
// against a real sshd and tmux in a throwaway container
// (tests/e2e/fixtures/ssh-host, started by scripts/ssh-test-host.cjs). The
// container's `claude` is a fake that prints the real banner and turn
// footers and logs every launch, so a second start would show.
//
// With the machines preference on, a Claude pane in an SSH workspace runs
// in tmux on the machine, keeps running when Studio quits, is attached to
// again (not started again) when the pane is restored, and ends when the
// pane is closed. With it off nothing changes: no tmux.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dockerAvailable, startSshTestHost } = require("../../scripts/ssh-test-host.cjs") as {
  dockerAvailable: () => Promise<boolean>;
  startSshTestHost: (opts: { dir: string }) => Promise<SshTestHost>;
};

interface SshTestHost {
  id: string;
  port: number;
  keyPath: string;
  user: string;
  projectPath: string;
  exec: (command: string) => Promise<string>;
  stop: () => Promise<void>;
}

interface Fixture {
  root: string;
  userDataDir: string;
  home: string;
  host: SshTestHost;
}

const HOST_ID = "testhost";
const WS_ID = "ws-remote";
const TMUX = "tmux -L codara -f /dev/null";

test.skip(process.platform !== "linux", "The SSH test host is a Linux container");

test("a Claude agent on an SSH machine outlives Studio and ends with its pane", async () => {
  test.skip(!(await dockerAvailable()), "Docker is not available");
  test.setTimeout(180_000);
  const fixture = await prepare({ machinesEnabled: true });
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    let page = await app.firstWindow();
    const paneId = await openClaudePane(page);

    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => sessions(fixture.host), { timeout: 15_000 }).toEqual([`codara-${paneId}`]);
    expect(await launches(fixture.host)).toHaveLength(1);

    // A turn through tmux is still seen as one.
    await typeInPane(page, paneId, "hello there");
    await expect(page.getByRole("status", { name: /^CLAUDE working/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => screen(fixture.host, paneId)).toContain("Done: hello there");

    // Quitting Studio leaves the agent working on the machine.
    const [pid] = await launches(fixture.host);
    await app.close();
    app = null;
    expect(await sessions(fixture.host)).toEqual([`codara-${paneId}`]);
    expect(await alive(fixture.host, pid)).toBe(true);

    // Reopening attaches to it: the same screen, no second launch.
    app = await launch(fixture);
    page = await app.firstWindow();
    await page.getByRole("tab", { name: /terminals/i }).first().click();
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    expect(await launches(fixture.host)).toEqual([pid]);
    await page.screenshot({ path: join(fixture.root, "..", "codara-remote-agent-reattached.png") });
    await typeInPane(page, paneId, "again");
    await expect.poll(() => screen(fixture.host, paneId), { timeout: 20_000 }).toContain("Done: again");
    expect(await screen(fixture.host, paneId)).toContain("Done: hello there");

    // Closing the pane on purpose ends it.
    await page.locator(`[data-terminal-pane-id="${paneId}"]`).first().hover();
    await page.locator(`[data-terminal-pane-id="${paneId}"]`).first().getByTitle(/Close pane/i).click();
    await expect.poll(() => sessions(fixture.host), { timeout: 20_000 }).toEqual([]);
    expect(await alive(fixture.host, pid)).toBe(false);
  } finally {
    await app?.close().catch(() => undefined);
    await cleanup(fixture);
  }
});

test("a dropped connection brings the same agent back into its pane", async () => {
  test.skip(!(await dockerAvailable()), "Docker is not available");
  test.setTimeout(120_000);
  const fixture = await prepare({ machinesEnabled: true });
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    const paneId = await openClaudePane(page);
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    await typeInPane(page, paneId, "before the drop");
    await expect.poll(() => screen(fixture.host, paneId), { timeout: 20_000 }).toContain("Done: before the drop");

    // Every SSH session of the user dies on the machine; tmux does not. The
    // agent's session loses its client, then Studio attaches a new one.
    expect(await clients(fixture.host, paneId)).toBe(1);
    await fixture.host.exec("pkill -f '[s]shd: dev@' || true").catch(() => undefined);
    await expect.poll(() => clients(fixture.host, paneId), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => clients(fixture.host, paneId), { timeout: 30_000 }).toBe(1);

    await typeInPane(page, paneId, "after the drop");
    await expect.poll(() => screen(fixture.host, paneId), { timeout: 30_000 }).toContain("Done: after the drop");
    expect(await launches(fixture.host)).toHaveLength(1);
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 20_000 });
  } finally {
    await app?.close().catch(() => undefined);
    await cleanup(fixture);
  }
});

test("with the machines preference off, a remote Claude pane runs as before, without tmux", async () => {
  test.skip(!(await dockerAvailable()), "Docker is not available");
  test.setTimeout(90_000);
  const fixture = await prepare({ machinesEnabled: false });
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await openClaudePane(page);
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    expect(await launches(fixture.host)).toHaveLength(1);
    expect(await sessions(fixture.host)).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await cleanup(fixture);
  }
});

async function openClaudePane(page: Page): Promise<string> {
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("tab", { name: /terminals/i }).first().click();
  const before = await paneIds(page);
  await page.getByTitle("Add pane…").first().click();
  await page.getByRole("menuitem", { name: /Claude worker/i }).click();
  let added = "";
  await expect
    .poll(async () => {
      added = (await paneIds(page)).find((id) => !before.includes(id)) ?? "";
      return added;
    }, { timeout: 15_000 })
    .not.toBe("");
  return added;
}

async function paneIds(page: Page): Promise<string[]> {
  return page
    .locator("[data-terminal-pane-id]")
    .evaluateAll((nodes) => [...new Set(nodes.map((n) => n.getAttribute("data-terminal-pane-id") ?? ""))].filter(Boolean));
}

// What the agent's screen shows, read on the machine.
async function screen(host: SshTestHost, paneId: string): Promise<string> {
  return host.exec(`${TMUX} capture-pane -p -S -200 -t '=codara-${paneId}:' 2>/dev/null || true`);
}

async function typeInPane(page: Page, paneId: string, text: string): Promise<void> {
  const input = page.locator(`[data-terminal-pane-id="${paneId}"] .xterm-helper-textarea`).first();
  await input.focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function sessions(host: SshTestHost): Promise<string[]> {
  const out = await host.exec(`${TMUX} list-sessions -F '#{session_name}' 2>/dev/null || true`);
  return out.split("\n").filter(Boolean);
}

// Terminals attached to a pane's agent session on the machine.
async function clients(host: SshTestHost, paneId: string): Promise<number> {
  const out = await host.exec(`${TMUX} list-clients -t '=codara-${paneId}' 2>/dev/null || true`);
  return out.split("\n").filter(Boolean).length;
}

async function launches(host: SshTestHost): Promise<number[]> {
  const out = await host.exec("cat /tmp/claude-launches.log 2>/dev/null || true");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line.split(" ")[0]));
}

async function alive(host: SshTestHost, pid: number): Promise<boolean> {
  return (await host.exec(`kill -0 ${pid} 2>/dev/null && echo yes || echo no`)).trim() === "yes";
}

async function prepare({ machinesEnabled }: { machinesEnabled: boolean }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-remote-agent-e2e-"));
  const userDataDir = join(root, "user-data");
  const home = join(root, "home");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(home, { recursive: true });
  const host = await startSshTestHost({ dir: join(root, "ssh") });
  // The user's ssh already knows the machine, so connecting asks nothing
  // (machines.spec.ts covers the question).
  const hostKeys = await host.exec("cat /etc/ssh/ssh_host_*_key.pub");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(
    join(home, ".ssh", "known_hosts"),
    hostKeys
      .split("\n")
      .filter(Boolean)
      .map((line) => `[127.0.0.1]:${host.port} ${line.split(" ").slice(0, 2).join(" ")}`)
      .join("\n") + "\n",
  );
  await writeFile(
    join(userDataDir, "spark-remote-hosts.json"),
    JSON.stringify([
      { id: HOST_ID, host: "127.0.0.1", port: host.port, username: host.user, identityFile: host.keyPath, source: "manual" },
    ]),
  );
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        {
          id: WS_ID,
          name: "remote",
          cwd: `ssh://${HOST_ID}${host.projectPath}`,
          remote: { hostId: HOST_ID },
          color: "#34D3C3",
          workers: [],
        },
      ],
      activeWorkspaceId: WS_ID,
    }),
  );
  await writeFile(join(userDataDir, "spark-preferences.json"), JSON.stringify({ machinesEnabled }));
  return { root, userDataDir, home, host };
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      // The user's own ~/.ssh (keys, config, agent) must never be used.
      HOME: fixture.home,
      SSH_AUTH_SOCK: "",
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
}

async function cleanup(fixture: Fixture): Promise<void> {
  await fixture.host.stop();
  await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
}
