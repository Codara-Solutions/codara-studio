// A Codara with three providers' accounts and limits, stubbed at the IPC
// boundary, for the title bar's Usage panel. No real login, CLI home or
// network is touched: every channel the panel reads or writes answers from
// the fixture below, and the homes point into a temporary folder.

import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Request = { channel: string; input: unknown };
type RosterFixtureState = {
  defaults: Record<string, string | undefined>;
  requests: Request[];
};
type RosterGlobal = typeof globalThis & { usageRosterFixture: RosterFixtureState };

export interface UsageRosterApp {
  app: ElectronApplication;
  page: Page;
  requests: () => Promise<Request[]>;
  close: () => Promise<void>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function window(
  id: string,
  label: string,
  usedPercent: number,
  resetsAt: number | null,
  scope?: Record<string, unknown>,
) {
  return {
    id,
    label,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    ...(resetsAt === null ? {} : { resetsAt: new Date(resetsAt).toISOString() }),
    ...(scope ? { scope } : { scope: { kind: "general" } }),
  };
}

/** The usage every account reports, built at launch so countdowns are live. */
function usageFixture(now: number) {
  const checkedAt = new Date(now - 2 * MINUTE).toISOString();
  return {
    checkedAt,
    providers: [],
    profiles: [
      {
        profileId: "claude-personal",
        provider: "anthropic",
        label: "Personal",
        isDefault: true,
        status: "ok",
        checkedAt,
        plan: "max",
        windows: [
          window("five_hour", "5-hour", 1, now + 2 * HOUR + 14 * MINUTE + 50_000),
          window("seven_day", "7-day", 26, now + 5 * 24 * HOUR + 3 * HOUR),
          window("limit_fable", "Fable 7-day", 0, now + 5 * 24 * HOUR + 3 * HOUR, {
            kind: "model",
            modelLabel: "Fable",
          }),
        ],
        credits: { kind: "spend", currency: "USD", spent: 12.5, limit: 50, usedPercent: 25 },
      },
      {
        profileId: "claude-work",
        provider: "anthropic",
        label: "Work",
        isDefault: false,
        status: "ok",
        checkedAt,
        plan: "pro",
        windows: [
          window("five_hour", "5-hour", 64, now + 40 * MINUTE),
          window("seven_day", "7-day", 48, now + 2 * 24 * HOUR),
        ],
      },
      {
        profileId: "codex-team",
        provider: "openai-codex",
        label: "Team",
        isDefault: true,
        status: "ok",
        checkedAt,
        plan: "plus",
        windows: [
          window("primary", "5-hour", 71, now + 47 * MINUTE),
          window("secondary", "7-day", 40, now + 3 * 24 * HOUR + 4 * HOUR),
          window("code_review_primary", "Code review 7-day", 5, now + 6 * 24 * HOUR, {
            kind: "code_review",
          }),
        ],
        credits: { kind: "balance", balance: 17, unlimited: false },
        resetCredits: { available: 2, nextExpiresAt: new Date(now + 3 * 24 * HOUR + 4 * HOUR + 30 * MINUTE).toISOString() },
      },
      {
        profileId: "grok-super",
        provider: "xai",
        label: "SuperGrok",
        isDefault: true,
        status: "ok",
        checkedAt,
        windows: [],
      },
    ],
  };
}

const ACCOUNT_ROWS = [
  { id: "claude-personal", provider: "anthropic", label: "Personal", email: "etienne@example.com", cliProfileId: "managed-personal" },
  { id: "claude-work", provider: "anthropic", label: "Work", email: "etienne@work.example", cliProfileId: "managed-work" },
  { id: "codex-team", provider: "openai-codex", label: "Team", email: "team@example.com", cliProfileId: "managed-team" },
  { id: "grok-super", provider: "xai", label: "SuperGrok", email: "grok@example.com", cliProfileId: "managed-grok" },
];

export async function launchUsageRosterApp(): Promise<UsageRosterApp> {
  const root = await mkdtemp(join(tmpdir(), "codara-usage-roster-e2e-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(root, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "usage", name: "Usage", cwd: workspace, workers: [] }],
      activeWorkspaceId: "usage",
    }),
  );
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: root,
      CODARA_HOME_DIR: root,
      SPARK_HOME_DIR: root,
      CODEX_HOME: join(root, "codex"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      GROK_HOME: join(root, "grok"),
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(
    ({ ipcMain, webContents }, fixture) => {
      const state: RosterFixtureState = ((globalThis as RosterGlobal).usageRosterFixture = {
        defaults: { anthropic: "claude-personal", "openai-codex": "codex-team", xai: "grok-super" },
        requests: [],
      });
      const overview = () => ({
        runtimeInstalled: true,
        runtimeVersion: "fixture",
        runtimeExpectedVersion: "fixture",
        connections: [],
        systemOffers: {},
        profiles: fixture.rows.map((row) => ({
          ...row,
          connected: true,
          expired: false,
          canRefresh: true,
          expiresAt: null,
          coraHalf: "linked",
          isDefault: state.defaults[row.provider] === row.id,
          terminal: { connected: true, expired: false, canRefresh: true },
        })),
      });
      const usage = () => ({
        ...fixture.usage,
        profiles: fixture.usage.profiles.map((profile) => ({
          ...profile,
          isDefault: state.defaults[profile.provider] === profile.profileId,
        })),
      });
      const channels = [
        "pi-subscriptions:status",
        "native-cli-accounts:inspect",
        "pi-subscriptions:usage",
        "pi-subscriptions:make-default",
        "pi-subscriptions:use-system-login",
        "pi-subscriptions:codex-reset",
      ];
      for (const channel of channels) ipcMain.removeHandler(channel);
      const record = (channel: string, input: unknown) => state.requests.push({ channel, input });
      ipcMain.handle("pi-subscriptions:status", overview);
      ipcMain.handle("native-cli-accounts:inspect", () => ({
        runtimes: [
          {
            runtime: "claude",
            defaultProfileId: "personal",
            profiles: [
              {
                runtime: "claude",
                id: "personal",
                label: "Claude Code",
                managed: false,
                isDefault: true,
                connected: true,
                inUse: false,
                status: "connected",
                email: "etienne@home.example",
              },
            ],
          },
          { runtime: "codex", defaultProfileId: "personal", profiles: [] },
          { runtime: "grok", defaultProfileId: "personal", profiles: [] },
        ],
      }));
      ipcMain.handle("pi-subscriptions:usage", (_event, input) => {
        record("usage", input);
        return usage();
      });
      ipcMain.handle("pi-subscriptions:make-default", (_event, input) => {
        record("make-default", input);
        state.defaults[input.provider] = input.profileId;
        return overview();
      });
      ipcMain.handle("pi-subscriptions:use-system-login", (_event, input) => {
        record("use-system-login", input);
        delete state.defaults[input.provider];
        return overview();
      });
      ipcMain.handle("pi-subscriptions:codex-reset", (_event, input) => {
        record("codex-reset", input);
        return { outcome: "reset" };
      });
      // The title bar read usage before the stubs existed; tell it to read again.
      for (const contents of webContents.getAllWebContents()) {
        contents.send("pi-subscriptions:event", { type: "usage" });
      }
    },
    { rows: ACCOUNT_ROWS, usage: usageFixture(Date.now()) },
  );
  return {
    app,
    page,
    requests: () => app.evaluate(() => (globalThis as RosterGlobal).usageRosterFixture.requests),
    close: async () => {
      await app.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
