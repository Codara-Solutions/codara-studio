import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// UI coverage for Settings, "Remote access" (docs/remote-access.md phase 1),
// driven through the REAL renderer, the REAL preload bridge, and the REAL
// ipcMain gate. Every remoteAccess:* channel is registered through the
// gate-by-default `handle` wrapper in src/main/ipc.ts, so a regression in the
// trusted-sender check would silently strand the user mid-pairing: the QR
// would never appear, or the Approve button would do nothing at all. Nothing
// here stubs the IPC layer, because the gate is exactly what is under test.
//
// The pairing half runs a real device against the real listener:
// scripts/remote-test-client.mjs speaks the same Noise IK + framed JSON wire
// protocol the phone does, so the "pending approval" state the desktop shows
// is produced by a genuine pairing request, not by an injected state.

const REPO_ROOT = process.cwd();
const CLIENT_SCRIPT = join(REPO_ROOT, "scripts", "remote-test-client.mjs");
// The name scripts/remote-test-client.mjs asks to be known by.
const CLIENT_DEVICE_NAME = "remote-test-client";

test("remote access starts off, enables into a pairing QR, and turns back off", async () => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture("codara-remote-access-ui-");
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const dialog = await openRemoteAccessSettings(page);

    // 1. The off state, as a fresh home always presents it.
    const toggle = dialog.getByRole("switch", { name: "Remote access" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveText("Turn on");
    await expect(dialog.getByText("Off. Paired devices cannot reach this computer.")).toBeVisible();
    await expect(dialog.getByText("No paired devices yet.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Pair a device" })).toHaveCount(0);

    // 2. Enabling from the UI: remoteAccess:setEnabled has to cross the gate,
    // start a real listener, and report back through remoteAccess:getStatus
    // and the status push. "Pair a device" only renders in the reachable
    // state, so waiting on it is waiting on a listener that is actually up.
    // The DHT announce is allowed to fail (an offline machine stays LAN-only);
    // the local rung is what pairing needs and what this asserts.
    await toggle.click({ force: true });
    await expect(dialog.getByRole("button", { name: "Pair a device" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveText("Turn off");
    await expect(dialog.getByText(/^port \d+$/)).toBeVisible();

    // The pairing modal round trips remoteAccess:startPairing and renders the
    // returned payload as a QR image.
    await dialog.getByRole("button", { name: "Pair a device" }).click({ force: true });
    const modal = page.getByRole("dialog", { name: "Pair a device" });
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Scan with the Codara app")).toBeVisible();
    await expect(modal.getByAltText("Pairing QR code")).toBeVisible();

    // 3. The secret behind that QR must live in the image and nowhere a human
    // (or a screenshot, or a screen share) can read it as text.
    const { secret, publicKey } = await mintPairingPayload(page);
    const rendered = await renderedText(page);
    expect(rendered.innerText).not.toContain(secret);
    expect(rendered.textContent).not.toContain(secret);
    // Same rule for this computer's own public key: the QR carries it, the
    // screen does not.
    expect(rendered.textContent).not.toContain(publicKey);

    // 4. Turning it back off tears the listener down and returns the panel to
    // the off state.
    await modal.getByRole("button", { name: "Cancel" }).click({ force: true });
    await expect(modal).toHaveCount(0);
    await toggle.click({ force: true });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveText("Turn on");
    await expect(dialog.getByText("Off. Paired devices cannot reach this computer.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Pair a device" })).toHaveCount(0);
  } finally {
    await app?.close();
  }
});

test("a real pairing request can be denied and then approved from the UI", async () => {
  test.setTimeout(180_000);
  const fixture = await prepareFixture("codara-remote-access-pairing-");
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const dialog = await openRemoteAccessSettings(page);

    const toggle = dialog.getByRole("switch", { name: "Remote access" });
    await toggle.click({ force: true });
    const pairButton = dialog.getByRole("button", { name: "Pair a device" });
    await expect(pairButton).toBeVisible({ timeout: 60_000 });

    /* ---- deny --------------------------------------------------------- */

    const modal = page.getByRole("dialog", { name: "Pair a device" });
    let pairing = await openPairingModal(page, dialog);
    let client = runPairClient(pairing.qrPayload, fixture.clientDir);

    await expect(modal.getByText("Approve this device?")).toBeVisible({ timeout: 60_000 });
    await expect(modal.getByText(CLIENT_DEVICE_NAME)).toBeVisible();
    // The confirmation fingerprint the user compares against the phone screen:
    // four groups of four uppercase hex digits.
    await expect(modal.locator(".spark-mono")).toHaveText(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);

    await modal.getByRole("button", { name: "Deny" }).click({ force: true });
    // Proof the click reached main: only the service can move the pairing
    // state to "denied", and only main can close the device's stream.
    await expect(modal.getByText("Pairing refused")).toBeVisible();
    let result = await client;
    expect(result.stderr).toContain("closed the connection without pairing");
    expect(result.code).not.toBe(0);

    await modal.getByRole("button", { name: "Close" }).click({ force: true });
    await expect(modal).toHaveCount(0);
    // A denied device is never written to the trust store.
    await expect(dialog.getByText("No paired devices yet.")).toBeVisible();

    /* ---- approve ------------------------------------------------------ */

    pairing = await openPairingModal(page, dialog);
    client = runPairClient(pairing.qrPayload, fixture.clientDir);

    await expect(modal.getByText("Approve this device?")).toBeVisible({ timeout: 60_000 });
    await modal.getByRole("button", { name: "Approve" }).click({ force: true });
    // Same proof on the other branch: "Paired" is pushed by the service after
    // it has written the device and answered the waiting client.
    await expect(modal.getByText("Paired", { exact: true })).toBeVisible();
    result = await client;
    expect(result.stderr).not.toContain("error:");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("paired with");

    await modal.getByRole("button", { name: "Done" }).click({ force: true });
    await expect(modal).toHaveCount(0);

    // The device list is main's trust store, read back over
    // remoteAccess:listDevices.
    const deviceRow = dialog.getByText(CLIENT_DEVICE_NAME);
    await expect(deviceRow).toBeVisible();
    await expect(dialog.getByText("No paired devices yet.")).toHaveCount(0);

    // The paired device's full key is a revoke handle the renderer holds but
    // must never show: only its eight-character short form belongs on screen.
    const devicePublicKey = await pairedClientPublicKey(fixture.clientDir);
    const rendered = await renderedText(page);
    expect(rendered.textContent).not.toContain(devicePublicKey);
    expect(rendered.innerText).toContain(devicePublicKey.slice(0, 8));
    expect(rendered.textContent).not.toContain(pairing.secret);

    await toggle.click({ force: true });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // Revoking is not exercised here, but a paired device survives the
    // listener going down: it is on disk, not in the listener.
    await expect(deviceRow).toBeVisible();
  } finally {
    await app?.close();
  }
});

/* -------------------------------------------------------------- fixtures */

interface Fixture {
  userDataDir: string;
  workspaceDir: string;
  clientDir: string;
}

async function prepareFixture(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  // The test client keeps its identity beside its working directory, so a
  // throwaway dir keeps a test device key out of the repo.
  const clientDir = join(root, "client");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(clientDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# Remote access probe\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          { id: "ws-remote", name: "workspace", cwd: workspaceDir, color: "#34D3C3", workers: [] },
        ],
        activeWorkspaceId: "ws-remote",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir, clientDir };
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      // Pin every home override the app honors: a shell inside the dev app
      // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
      // point this instance at the user's real ~/.Codara. Remote access keys
      // and paired devices live under that home, so an unpinned run would
      // write a test device into the user's real trust store.
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
}

/* ------------------------------------------------------------------- ui */

async function openRemoteAccessSettings(page: Page): Promise<Locator> {
  await page.getByTitle("Settings").click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.locator("nav").getByRole("button", { name: "Remote access" }).click({ force: true });
  await expect(dialog.getByRole("switch", { name: "Remote access" })).toBeVisible();
  return dialog;
}

interface PairingPayload {
  qrPayload: string;
  secret: string;
}

// Opens the pairing modal and returns a payload a client can actually pair
// with. The modal's own QR payload never crosses back to the test in readable
// form (it is drawn into an image and nothing else), so the test mints a
// second pairing window over the same real preload bridge and the same gated
// remoteAccess:startPairing channel. That window replaces the modal's, which
// is what the running app does too, and the modal follows the service's
// pairing state either way, so the approve/deny buttons under test are driven
// by exactly the state a phone would produce.
async function openPairingModal(page: Page, dialog: Locator): Promise<PairingPayload> {
  await dialog.getByRole("button", { name: "Pair a device" }).click({ force: true });
  const modal = page.getByRole("dialog", { name: "Pair a device" });
  await expect(modal).toBeVisible();
  // The QR image only renders once the modal's own startPairing has resolved.
  // Waiting for it keeps the modal's window from replacing the one below.
  await expect(modal.getByAltText("Pairing QR code")).toBeVisible();
  return mintPairingPayload(page);
}

async function mintPairingPayload(page: Page): Promise<PairingPayload & { publicKey: string }> {
  const qrPayload = await page.evaluate(async () => {
    const spark = (window as unknown as { spark: { remoteAccess: { startPairing(): Promise<{ qrPayload: string }> } } }).spark;
    const session = await spark.remoteAccess.startPairing();
    return session.qrPayload;
  });
  const payload = JSON.parse(qrPayload) as {
    secret: string;
    pk: string;
    addrs: string[];
  };
  // The QR advertises this machine's LAN addresses first and 127.0.0.1 last,
  // precisely so a same-machine client can reach the listener. Dial only the
  // loopback rung: sending this hop out to a physical interface and back adds
  // nothing to what is under test, and makes the run depend on whichever VPN
  // or virtual adapter happens to be up on the machine.
  return {
    qrPayload: JSON.stringify({ ...payload, addrs: ["127.0.0.1"] }),
    secret: payload.secret,
    publicKey: payload.pk,
  };
}

async function renderedText(page: Page): Promise<{ innerText: string; textContent: string }> {
  return page.evaluate(() => ({
    innerText: document.body.innerText,
    textContent: document.body.textContent ?? "",
  }));
}

/* --------------------------------------------------------------- client */

interface ClientRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

// A pair run blocks on the desktop's decision, so a test that fails before it
// clicks would otherwise leave the client waiting out its 65s deadline.
const liveClients = new Set<ChildProcess>();
test.afterEach(() => {
  for (const child of liveClients) child.kill();
  liveClients.clear();
});

// Runs the phone stand-in against the live listener. It dials, proves the
// pairing secret, and then blocks on the desktop user's decision, so the
// promise stays pending until the Approve or Deny click below has travelled
// renderer -> preload -> ipcMain and back out over the wire.
function runPairClient(qrPayload: string, cwd: string): Promise<ClientRun> {
  const child = spawn(process.execPath, [CLIENT_SCRIPT, "pair", qrPayload], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveClients.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return new Promise<ClientRun>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      liveClients.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

async function pairedClientPublicKey(clientDir: string): Promise<string> {
  const state = JSON.parse(
    await readFile(join(clientDir, "remote-test-client-state.json"), "utf8"),
  ) as { identity: { publicKey: string } };
  return state.identity.publicKey;
}
