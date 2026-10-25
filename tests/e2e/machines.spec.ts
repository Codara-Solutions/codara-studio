import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Machines page and the Where picker (Machines phase 2) against a real
// sshd and tmux in a throwaway container limited to 1 CPU and 512 MiB
// (tests/e2e/fixtures/ssh-host, started by scripts/ssh-test-host.cjs).
//
// Adding a machine asks to confirm its host key, then the page shows the
// container's limits rather than the host's; an agent started from the Add
// pane menu's Where row runs on the machine, in tmux, and the page lists it.
// A machine whose key changed is refused until the new key is trusted, and a
// key the user's own known_hosts lists connects without a question.

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
  project: string;
  host: SshTestHost;
}

const TMUX = "tmux -L codara -f /dev/null";
const MACHINE = "testbox";

test.skip(process.platform !== "linux", "The SSH test host is a Linux container");

test("add a machine, confirm its key, see its limits, and start an agent on it from the Where picker", async () => {
  test.skip(!(await dockerAvailable()), "Docker is not available");
  test.setTimeout(180_000);
  const fixture = await prepare({});
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await openMachines(page);

    await page.getByRole("button", { name: "Add a machine" }).click();
    await page.getByPlaceholder("vps1").fill(MACHINE);
    await page.getByPlaceholder(/203\.0\.113\.7/).fill(`dev@127.0.0.1:${fixture.host.port}`);
    await page.getByPlaceholder(/id_ed25519/).fill(fixture.host.keyPath);
    await page.getByRole("button", { name: "Save host" }).click();

    const card = page.locator(`[data-machine-id="${MACHINE}"]`);
    await expect(card).toContainText("Not connected");
    await card.getByRole("button", { name: "Connect" }).click();

    const prompt = page.getByRole("dialog", { name: `Is this ${MACHINE}?` });
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    const keyType = (await prompt.locator("[data-host-key-type]").getAttribute("data-host-key-type")) ?? "";
    const expected = await hostFingerprint(fixture.host, keyType);
    await expect(prompt).toContainText(expected);
    await page.screenshot({ path: join(fixture.root, "..", "codara-machines-hostkey.png") });
    await prompt.getByRole("button", { name: "Trust and connect" }).click();

    await expect(card).toContainText("Connected", { timeout: 20_000 });
    await expect(card).toContainText("of 1 CPU, container limit", { timeout: 20_000 });
    await expect(card).toContainText("/ 512 MB");
    await expect(card).toContainText("container limit");
    await expect(card).toContainText("Claude Code");
    await expect(card).toContainText("Codex not installed");
    await page.screenshot({ path: join(fixture.root, "..", "codara-machines-page.png") });

    // An agent session no pane on this computer shows (closed while offline) is listed with Stop.
    await fixture.host.exec(`${TMUX} new-session -d -s codara-pane-ghost 'sleep 600'`);
    await expect(card).toContainText("Not open here", { timeout: 25_000 });
    await card.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => sessions(fixture.host), { timeout: 15_000 }).toEqual([]);

    // One that Codara on another computer has open (a tmux client is attached)
    // is never stopped, even when the client attached after the last reading.
    await fixture.host.exec(`${TMUX} new-session -d -s codara-pane-away 'sleep 600'`);
    await expect(card).toContainText("Not open here", { timeout: 25_000 });
    await fixture.host.exec(
      `(sleep 600 | TERM=xterm script -qfc "${TMUX} attach -t =codara-pane-away" /dev/null) >/dev/null 2>&1 &`,
    );
    await expect.poll(() => fixture.host.exec(`${TMUX} list-clients -t =codara-pane-away`), { timeout: 10_000 }).not.toBe("");
    const stopped = await page.evaluate((id) => window.spark.machines.stopSession(id, "codara-pane-away"), MACHINE);
    expect(stopped).toBe(false);
    expect(await sessions(fixture.host)).toEqual(["codara-pane-away"]);
    const away = card.locator(".machine-agent", { hasText: "Open elsewhere" });
    await expect(away).toBeVisible({ timeout: 25_000 });
    await expect(away.getByRole("button", { name: "Stop" })).toBeDisabled();
    await fixture.host.exec(`${TMUX} kill-session -t =codara-pane-away`);

    // The Where row of the Add pane menu starts Claude on the machine.
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: /terminals/i }).first().click();
    const before = await paneIds(page);
    await page.getByTitle("Add pane…").first().click();
    const where = page.getByRole("radiogroup", { name: "Where" });
    await expect(where).toBeVisible({ timeout: 10_000 });
    await where.getByRole("radio", { name: MACHINE }).click();
    await expect(page.getByRole("menuitem", { name: /Claude worker/i })).toContainText(`on ${MACHINE}`);
    await page.getByRole("menuitem", { name: /Claude worker/i }).click();
    let paneId = "";
    await expect
      .poll(async () => {
        paneId = (await paneIds(page)).find((id) => !before.includes(id)) ?? "";
        return paneId;
      }, { timeout: 15_000 })
      .not.toBe("");
    await expect.poll(() => sessions(fixture.host), { timeout: 30_000 }).toEqual([`codara-${paneId}`]);
    await expect.poll(() => launches(fixture.host), { timeout: 15_000 }).toHaveLength(1);
    const [pid] = await launches(fixture.host);
    expect((await fixture.host.exec(`readlink /proc/${pid}/cwd`)).trim()).toBe("/home/dev");

    await openMachines(page);
    await expect(card.getByRole("list", { name: `Agents on ${MACHINE}` })).toContainText("Claude Code", { timeout: 25_000 });
    await page.screenshot({ path: join(fixture.root, "..", "codara-machines-agent.png") });
  } finally {
    await app?.close().catch(() => undefined);
    await cleanup(fixture);
  }
});

test("a changed host key is refused until the new key is trusted", async () => {
  test.skip(!(await dockerAvailable()), "Docker is not available");
  test.setTimeout(120_000);
  const fixture = await prepare({ registerHost: true, knownFingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await openMachines(page);
    const card = page.locator(`[data-machine-id="${MACHINE}"]`);
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card).toContainText("Key changed", { timeout: 20_000 });
    await expect(card).toContainText("Before: SHA256:AAAAAAAA");
    await expect(page.getByRole("dialog", { name: `Is this ${MACHINE}?` })).toHaveCount(0);
    await page.screenshot({ path: join(fixture.root, "..", "codara-machines-key-changed.png") });
    await card.getByRole("button", { name: "Trust the new key" }).click();
    await expect(card).toContainText("Connected", { timeout: 20_000 });
  } finally {
    await app?.close().catch(() => undefined);
    await cleanup(fixture);
  }
});

test("a machine your known_hosts lists connects without asking", async () => {
  test.skip(!(await dockerAvailable()), "Docker is not available");
  test.setTimeout(120_000);
  const fixture = await prepare({ registerHost: true });
  let app: ElectronApplication | null = null;
  try {
    const keys = await fixture.host.exec("cat /etc/ssh/ssh_host_*_key.pub");
    await mkdir(join(fixture.home, ".ssh"), { recursive: true });
    await writeFile(
      join(fixture.home, ".ssh", "known_hosts"),
      keys
        .split("\n")
        .filter(Boolean)
        .map((line) => `[127.0.0.1]:${fixture.host.port} ${line.split(" ").slice(0, 2).join(" ")}`)
        .join("\n") + "\n",
    );
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await openMachines(page);
    const card = page.locator(`[data-machine-id="${MACHINE}"]`);
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card).toContainText("Connected", { timeout: 20_000 });
    await expect(page.getByRole("dialog", { name: `Is this ${MACHINE}?` })).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    await cleanup(fixture);
  }
});

test("with no SSH machines, Machines on by default changes nothing you would notice", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-machines-none-e2e-"));
  const local = { root, userDataDir: join(root, "user-data"), home: join(root, "home"), project: join(root, "project") };
  for (const dir of [local.userDataDir, local.home, local.project]) await mkdir(dir, { recursive: true });
  await writeFile(
    join(local.userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-local", name: "project", cwd: local.project, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-local",
    }),
  );
  let app: ElectronApplication | null = null;
  try {
    // No preference file and no hosts: a fresh install, or an update.
    app = await launch({ ...local, host: null as unknown as SshTestHost });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("tab", { name: /terminals/i }).first().click();
    await page.getByTitle("Add pane…").first().click();
    await expect(page.getByRole("menuitem", { name: /Claude worker/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("radiogroup", { name: "Where" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /Claude worker/i })).not.toContainText(/\son\s/);
    await page.keyboard.press("Escape");

    await openMachines(page);
    await expect(page.getByRole("switch", { name: /Keep agents running on SSH machines/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator("[data-machine-id]")).toHaveCount(1);
    await expect(page.locator('[data-machine-id="local"]')).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function openMachines(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("spark:open-settings", { detail: { section: "machines" } })),
  );
  await expect(page.getByRole("heading", { name: "Machines" }).first()).toBeVisible({ timeout: 10_000 });
}

async function paneIds(page: Page): Promise<string[]> {
  return page
    .locator("[data-terminal-pane-id]")
    .evaluateAll((nodes) => [...new Set(nodes.map((n) => n.getAttribute("data-terminal-pane-id") ?? ""))].filter(Boolean));
}

/** What `ssh-keygen -lf` says for the machine's key of this type. */
async function hostFingerprint(host: SshTestHost, keyType: string): Promise<string> {
  const file = keyType.includes("ed25519") ? "ed25519" : keyType.startsWith("ecdsa") ? "ecdsa" : "rsa";
  const out = await host.exec(`ssh-keygen -lf /etc/ssh/ssh_host_${file}_key.pub`);
  return out.split(/\s+/)[1];
}

async function sessions(host: SshTestHost): Promise<string[]> {
  const out = await host.exec(`${TMUX} list-sessions -F '#{session_name}' 2>/dev/null || true`);
  return out.split("\n").filter(Boolean);
}

async function launches(host: SshTestHost): Promise<number[]> {
  const out = await host.exec("cat /tmp/claude-launches.log 2>/dev/null || true");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line.split(" ")[0]));
}

async function prepare({
  registerHost = false,
  knownFingerprint,
}: {
  registerHost?: boolean;
  knownFingerprint?: string;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-machines-e2e-"));
  const userDataDir = join(root, "user-data");
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const host = await startSshTestHost({ dir: join(root, "ssh") });
  if (registerHost) {
    await writeFile(
      join(userDataDir, "spark-remote-hosts.json"),
      JSON.stringify([
        { id: MACHINE, host: "127.0.0.1", port: host.port, username: host.user, identityFile: host.keyPath, source: "manual" },
      ]),
    );
  }
  if (knownFingerprint) {
    await writeFile(
      join(userDataDir, "spark-known-hosts.json"),
      JSON.stringify({ [`127.0.0.1:${host.port}`]: knownFingerprint }),
    );
  }
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-local", name: "project", cwd: project, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-local",
    }),
  );
  // No preference file: Machines is on by default.
  return { root, userDataDir, home, project, host };
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      // The user's own ~/.ssh (keys, config, known_hosts, agent) must never be used.
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
