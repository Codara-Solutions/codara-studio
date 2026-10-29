// A Codara whose title bar shows Claude, ChatGPT and Grok usage, stubbed at
// the IPC boundary. Two states mirror the mock-up Etienne picked from:
// "fine" (every limit far from running out, two banked ChatGPT resets that
// cannot be used yet) and "busy" (Claude's 5-hour limit runs out before it
// resets, ChatGPT's week is at 91%). No real login, CLI home or network is
// touched, and spending a reset only records the request.

import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageForecastReport, WindowForecastView } from "../../src/shared/usage-forecast";

export type HairlineState = "fine" | "busy";

type Request = { channel: string; input: unknown };
type FixtureGlobal = typeof globalThis & {
  usageHairlinesFixture: {
    state: HairlineState;
    defaults: Record<string, string | undefined>;
    requests: Request[];
  };
};

export interface UsageHairlinesApp {
  app: ElectronApplication;
  page: Page;
  requests: () => Promise<Request[]>;
  /** Swaps the data main answers with and reloads the window. */
  setState: (state: HairlineState) => Promise<void>;
  close: () => Promise<void>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function usageWindow(id: string, label: string, usedPercent: number, resetsAt: number, scope?: Record<string, unknown>) {
  return {
    id,
    label,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: new Date(resetsAt).toISOString(),
    scope: scope ?? { kind: "general" },
  };
}

/** What the renderer reads of a forecast, with the rest filled plausibly. */
function view(
  now: number,
  profileId: string,
  provider: "anthropic" | "openai-codex",
  windowId: string,
  windowLabel: string,
  usedPercent: number,
  resetsAtMs: number,
  lengthMs: number,
  outcome: { end: number } | { hitAt: number },
): WindowForecastView {
  const hit = "hitAt" in outcome ? outcome.hitAt : null;
  const end = "end" in outcome ? outcome.end : 100;
  return {
    key: `${profileId}|${windowId}`,
    profileId,
    provider,
    accountLabel: profileId,
    active: true,
    windowId,
    windowLabel,
    source: "live",
    calibration: { method: "readings", anchors: 12, spread: [1, 1], note: "Fixture." },
    learning: null,
    result: {
      nowMs: now,
      windowStartMs: resetsAtMs - lengthMs,
      resetsAtMs,
      usedPercent,
      kind: lengthMs === 5 * HOUR ? "5h" : "7d",
      observed: [[now, usedPercent]],
      cone: [],
      endPercent: { p10: Math.max(usedPercent, end - 5), p50: end, p90: Math.min(100, end + 6) },
      hitProbability: hit === null ? 0.02 : 0.82,
      growthQuantiles: [],
      hitAt: { p10: hit === null ? null : hit - 10 * MINUTE, p50: hit, p90: hit === null ? null : hit + 15 * MINUTE },
      pace: { recentPerHour: 4, usualPerHour: 3, ratio: 1.3 },
      analogDays: 14,
      level: 1,
      inUse: true,
    },
    verdict: { tone: hit === null ? "calm" : "danger", headline: "", detail: "" },
    nudge: null,
    goAhead: null,
  } as WindowForecastView;
}

function data(state: HairlineState, now: number) {
  const busy = state === "busy";
  const checkedAt = new Date(now - MINUTE).toISOString();
  const fiveHourReset = now + 3 * HOUR + 30 * MINUTE;
  const weekReset = now + 6 * DAY + 7 * HOUR;
  const codexReset = now + 5 * DAY + 15 * HOUR;
  const used = busy ? { five: 82, week: 34, fable: 12, codex: 91 } : { five: 0, week: 1, fable: 0, codex: 0 };
  const overview = {
    checkedAt,
    providers: [],
    profiles: [
      {
        profileId: "claude-main",
        provider: "anthropic",
        label: "Main",
        isDefault: true,
        status: "ok",
        checkedAt,
        plan: "max",
        windows: [
          usageWindow("five_hour", "5-hour", used.five, fiveHourReset),
          usageWindow("seven_day", "7-day", used.week, weekReset),
          usageWindow("limit_fable", "Fable 7-day", used.fable, weekReset, { kind: "model", modelLabel: "Fable" }),
        ],
      },
      {
        profileId: "claude-main-2",
        provider: "anthropic",
        label: "Main 2",
        isDefault: false,
        status: "ok",
        checkedAt,
        plan: "max",
        windows: [
          usageWindow("five_hour", "5-hour", 2, now + 4 * HOUR),
          usageWindow("seven_day", "7-day", 1, now + 3 * DAY),
        ],
      },
      {
        profileId: "codex-pro",
        provider: "openai-codex",
        label: "Account 1",
        isDefault: true,
        status: "ok",
        checkedAt,
        plan: "pro",
        windows: [usageWindow("secondary", "7-day", used.codex, codexReset)],
        resetCredits: {
          available: 2,
          applicable: busy ? 2 : 0,
          nextExpiresAt: new Date(now + 2 * HOUR + 48 * MINUTE).toISOString(),
          credits: [
            {
              id: "credit-soon",
              expiresAt: new Date(now + 2 * HOUR + 48 * MINUTE).toISOString(),
              grantedAt: new Date(now - 30 * DAY).toISOString(),
            },
            {
              id: "credit-later",
              expiresAt: new Date(now + 8 * DAY + 7 * HOUR).toISOString(),
              grantedAt: new Date(now - 21 * DAY).toISOString(),
            },
          ],
        },
      },
      {
        profileId: "grok-1",
        provider: "xai",
        label: "Account 1",
        isDefault: true,
        status: "not_connected",
        checkedAt,
        windows: [],
      },
    ],
  };
  const windows: WindowForecastView[] = [
    view(now, "claude-main", "anthropic", "five_hour", "5-hour", used.five, fiveHourReset, 5 * HOUR,
      busy ? { hitAt: now + 40 * MINUTE } : { end: 35 }),
    view(now, "claude-main", "anthropic", "seven_day", "7-day", used.week, weekReset, 7 * DAY, { end: busy ? 61 : 24 }),
    view(now, "codex-pro", "openai-codex", "secondary", "7-day", used.codex, codexReset, 7 * DAY,
      busy ? { hitAt: codexReset - (3 * DAY + 21 * HOUR) } : { end: 6 }),
  ];
  // Fable has a forecast only when busy: when fine it shows what a window
  // with too little history looks like.
  if (busy) windows.push(view(now, "claude-main", "anthropic", "limit_fable", "Fable 7-day", used.fable, weekReset, 7 * DAY, { end: 30 }));
  const report: UsageForecastReport = {
    generatedAt: now,
    windows,
    nextAccount: {},
    activeSessions: { anthropic: busy ? 3 : 0, "openai-codex": busy ? 1 : 0 },
    patterns: [],
    backtest: [],
    sources: ["Fixture."],
    notes: [],
  } as unknown as UsageForecastReport;
  return { overview, report };
}

const ACCOUNT_ROWS = [
  { id: "claude-main", provider: "anthropic", label: "Main", email: "info@codarasolutions.com", cliProfileId: "managed-main", coraHalf: "linked" },
  { id: "claude-main-2", provider: "anthropic", label: "Main 2", email: "edescombes@codarasolutions.com", cliProfileId: "managed-main-2", coraHalf: "linked" },
  { id: "codex-pro", provider: "openai-codex", label: "Account 1", email: "pro@example.com", cliProfileId: "managed-codex", coraHalf: "linked" },
  { id: "grok-1", provider: "xai", label: "Account 1", email: "grok@example.com", cliProfileId: null, coraHalf: "none", builtIn: true },
];

export async function launchUsageHairlinesApp(
  state: HairlineState,
  options: { forecastOff?: boolean } = {},
): Promise<UsageHairlinesApp> {
  const root = await mkdtemp(join(tmpdir(), "codara-usage-hairlines-e2e-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(root, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "usage", name: "Usage", cwd: workspace, workers: [] }],
      activeWorkspaceId: "usage",
    }),
  );
  await writeFile(
    join(root, "spark-preferences.json"),
    JSON.stringify({
      theme: "dark",
      ...(options.forecastOff ? { usageForecast: false, usageForecastChosen: true } : {}),
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
      SPARK_ALLOW_MULTI: "1",
      CODARA_E2E_SEED_TERMINAL: "0",
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.waitForLoadState("domcontentloaded");
  const now = Date.now();
  await app.evaluate(
    ({ ipcMain, webContents }, fixture) => {
      const store: FixtureGlobal["usageHairlinesFixture"] = {
        state: fixture.state,
        defaults: { anthropic: "claude-main", "openai-codex": "codex-pro", xai: "grok-1" },
        requests: [],
      };
      (globalThis as FixtureGlobal).usageHairlinesFixture = store;
      const current = () => fixture.data[store.state];
      const status = () => ({
        runtimeInstalled: true,
        runtimeVersion: "fixture",
        runtimeExpectedVersion: "fixture",
        connections: [],
        systemOffers: {},
        profiles: fixture.rows.map((row) => ({
          ...row,
          connected: row.coraHalf !== "none",
          expired: false,
          canRefresh: true,
          expiresAt: null,
          isDefault: store.defaults[row.provider] === row.id,
          terminal: { connected: true, expired: false, canRefresh: true },
        })),
      });
      const usage = () => ({
        ...current().overview,
        profiles: current().overview.profiles.map((profile) => ({
          ...profile,
          isDefault: store.defaults[profile.provider] === profile.profileId,
        })),
      });
      const channels = [
        "pi-subscriptions:status",
        "native-cli-accounts:inspect",
        "pi-subscriptions:usage",
        "pi-subscriptions:make-default",
        "pi-subscriptions:use-system-login",
        "pi-subscriptions:codex-reset",
        "usage-forecast:read",
      ];
      for (const channel of channels) ipcMain.removeHandler(channel);
      const record = (channel: string, input: unknown) => store.requests.push({ channel, input });
      ipcMain.handle("pi-subscriptions:status", status);
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
                email: "info@codarasolutions.com",
              },
            ],
          },
          { runtime: "codex", defaultProfileId: null, profiles: [] },
          { runtime: "grok", defaultProfileId: null, profiles: [] },
        ],
      }));
      ipcMain.handle("pi-subscriptions:usage", (_event, input) => {
        record("usage", input);
        return usage();
      });
      ipcMain.handle("usage-forecast:read", () => (fixture.forecastOff ? null : current().report));
      ipcMain.handle("pi-subscriptions:make-default", (_event, input) => {
        record("make-default", input);
        store.defaults[input.provider] = input.profileId;
        return status();
      });
      ipcMain.handle("pi-subscriptions:use-system-login", (_event, input) => {
        record("use-system-login", input);
        delete store.defaults[input.provider];
        return status();
      });
      // Never the real consume endpoint: the request is recorded and answered here.
      ipcMain.handle("pi-subscriptions:codex-reset", (_event, input) => {
        record("codex-reset", input);
        return { outcome: "reset" };
      });
      for (const contents of webContents.getAllWebContents()) {
        contents.send("pi-subscriptions:event", { type: "usage" });
      }
    },
    {
      state,
      rows: ACCOUNT_ROWS,
      forecastOff: options.forecastOff === true,
      data: { fine: data("fine", now), busy: data("busy", now) },
    },
  );
  // The renderer read before the stubs existed; a reload reads them fresh.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  return {
    app,
    page,
    requests: () => app.evaluate(() => (globalThis as FixtureGlobal).usageHairlinesFixture.requests),
    setState: async (next) => {
      await app.evaluate((_electron, value) => {
        (globalThis as FixtureGlobal).usageHairlinesFixture.state = value;
      }, next);
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
    },
    close: async () => {
      await app.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
