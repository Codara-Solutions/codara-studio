// A Codara with the usage forecast, stubbed at the IPC boundary like
// usage-hairlines.fixture.ts: accounts, usage and the forecast report answer
// from data built here, and every home points into a temporary folder. The
// report is computed by the real model on a synthetic history, so the panel
// and the chart draw what the model really says.
//
// CODARA_FORECAST_DEMO_DIR may point at a folder with overview.json and
// report.json to draw those instead (used to take screenshots of a real
// report; nothing from it is kept in the repository).

import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backtestForecast,
  burnNudge,
  describeForecast,
  forecastWindow,
  goAheadNote,
  pastWindowsFromSpend,
  suggestNextAccount,
  weeklyPattern,
  type BurnSeries,
  type UsageForecastReport,
  type WindowForecastView,
} from "../../src/shared/usage-forecast";
import {
  describeLearning,
  fitErrorModel,
  learnedBacktest,
  samplesFromBacktest,
} from "../../src/shared/usage-forecast-learning";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUCKET = 15 * MINUTE;

export interface ForecastAppOptions {
  /** False writes the user's own choice to turn it off; true leaves the
   * default, which is on. */
  forecast: boolean;
  theme?: string;
  /** Whether to answer usage-forecast:read from the fixture. Off, the real
   * main handler answers, which is how the flag-off test proves it says null. */
  stubForecast?: boolean;
}

export interface ForecastApp {
  app: ElectronApplication;
  page: Page;
  close: () => Promise<void>;
}

function usageWindow(id: string, label: string, usedPercent: number, resetsAt: number) {
  return {
    id,
    label,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: new Date(resetsAt).toISOString(),
    scope: { kind: "general" },
  };
}

/** Busy around the clock at 18% of a 5-hour window per hour, so the answer
 * does not depend on the hour the test runs at. */
function syntheticHistory(now: number): BurnSeries {
  const start = new Date(now - 21 * DAY);
  start.setHours(0, 0, 0, 0);
  const values: number[] = [];
  for (let t = start.getTime(); t <= now; t += BUCKET) {
    const burst = now - t <= HOUR ? 3 : 1;
    values.push(t < now ? (18 / 4) * burst : 0);
  }
  return { startMs: start.getTime(), bucketMs: BUCKET, values };
}

function syntheticData(now: number): { overview: unknown; report: UsageForecastReport } {
  const checkedAt = new Date(now - MINUTE).toISOString();
  const work5Reset = now + 2 * HOUR + 30 * MINUTE;
  const work7Reset = now + 3 * DAY + 4 * HOUR;
  const personal5Reset = now + 3 * HOUR + 10 * MINUTE;
  const codex7Reset = now + 5 * DAY;
  const overview = {
    checkedAt,
    providers: [],
    profiles: [
      {
        profileId: "claude-work",
        provider: "anthropic",
        label: "Work",
        isDefault: true,
        status: "ok",
        checkedAt,
        plan: "max",
        windows: [usageWindow("five_hour", "5-hour", 64, work5Reset), usageWindow("seven_day", "7-day", 48, work7Reset)],
      },
      {
        profileId: "claude-personal",
        provider: "anthropic",
        label: "Personal",
        isDefault: false,
        status: "ok",
        checkedAt,
        plan: "max",
        windows: [usageWindow("five_hour", "5-hour", 3, personal5Reset), usageWindow("seven_day", "7-day", 9, now + 6 * DAY)],
      },
      {
        profileId: "codex-pro",
        provider: "openai-codex",
        label: "ChatGPT Pro",
        isDefault: true,
        status: "ok",
        checkedAt,
        plan: "pro",
        windows: [usageWindow("secondary", "7-day", 12, codex7Reset)],
      },
    ],
  };

  const history = syntheticHistory(now);
  const past = pastWindowsFromSpend(history, 5 * HOUR, 1, now);
  const { cases, summary } = backtestForecast({ windows: past.slice(-12), history, percentPerUnit: [1], kind: "5h", paths: 60 });
  const walked = learnedBacktest(cases, "5h");
  const learning = describeLearning(fitErrorModel(samplesFromBacktest(cases), now, "5h"), walked.cases);
  const spec = [
    { profileId: "claude-work", provider: "anthropic", account: "Work", active: true, id: "five_hour", label: "5-hour", used: 64, start: work5Reset - 5 * HOUR, reset: work5Reset, factor: 1 },
    { profileId: "claude-work", provider: "anthropic", account: "Work", active: true, id: "seven_day", label: "7-day", used: 48, start: work7Reset - 7 * DAY, reset: work7Reset, factor: 0.05 },
    { profileId: "claude-personal", provider: "anthropic", account: "Personal", active: false, id: "five_hour", label: "5-hour", used: 3, start: personal5Reset - 5 * HOUR, reset: personal5Reset, factor: 1 },
    { profileId: "codex-pro", provider: "openai-codex", account: "ChatGPT Pro", active: true, id: "secondary", label: "7-day", used: 12, start: codex7Reset - 7 * DAY, reset: codex7Reset, factor: 0.004 },
  ] as const;
  const windows: WindowForecastView[] = spec.map((entry, index) => {
    const result = forecastWindow({
      nowMs: now,
      windowStartMs: entry.start,
      resetsAtMs: entry.reset,
      usedPercent: entry.used,
      kind: entry.label === "5-hour" ? "5h" : "7d",
      history,
      percentPerUnit: [entry.factor * 0.9, entry.factor, entry.factor * 1.1],
      inUse: entry.active,
      ...(entry.active ? { correction: learning.correction } : {}),
      paths: 200,
      seed: index + 1,
    });
    return {
      key: `${entry.profileId}|${entry.id}`,
      profileId: entry.profileId,
      provider: entry.provider,
      accountLabel: entry.account,
      active: entry.active,
      windowId: entry.id,
      windowLabel: entry.label,
      source: "live",
      calibration: {
        method: "spend",
        anchors: 3,
        spread: [0.9, 1.1],
        note: "Spend from the transcripts, turned into percent with this window's live reading.",
      },
      learning: entry.active ? learning : null,
      result,
      verdict: describeForecast(result, entry.label),
      nudge: burnNudge(result, 5, entry.label),
      goAhead: goAheadNote(result, entry.label),
    };
  });
  const tightest = (profileId: string) =>
    windows
      .filter((view) => view.profileId === profileId)
      .sort((a, b) => b.result.endPercent.p50 - a.result.endPercent.p50)[0];
  const work = tightest("claude-work");
  const personal = tightest("claude-personal");
  const next = suggestNextAccount(
    [
      { profileId: "claude-work", label: "Work", active: true, tightestEnd: work?.result.endPercent.p50 ?? 0, tightestLabel: "5-hour", resetsAtMs: work5Reset },
      { profileId: "claude-personal", label: "Personal", active: false, tightestEnd: personal?.result.usedPercent ?? 0, tightestLabel: "5-hour", resetsAtMs: personal5Reset },
    ],
    now,
  );
  const report: UsageForecastReport = {
    generatedAt: now,
    windows,
    nextAccount: next ? { anthropic: next } : {},
    activeSessions: { anthropic: 5, "openai-codex": 0 },
    patterns: [{ provider: "anthropic", windowLabel: "5-hour", ...weeklyPattern(history, 1, now) }],
    backtest: [
      {
        provider: "anthropic",
        windowLabel: "5-hour",
        truth: "spend",
        summary,
        learned: walked.summary,
        byHistory: walked.byHistory,
        learning,
        recent: [],
      },
    ],
    sources: ["Synthetic history for the test."],
    notes: [],
  };
  return { overview, report };
}

function accountRows(overview: { profiles: Array<{ profileId: string; provider: string; label: string; isDefault: boolean }> }) {
  return overview.profiles.map((profile) => ({
    id: profile.profileId,
    provider: profile.provider,
    label: profile.label,
    cliProfileId: `managed-${profile.profileId}`,
    connected: true,
    expired: false,
    canRefresh: true,
    expiresAt: null,
    coraHalf: "linked",
    isDefault: profile.isDefault,
    terminal: { connected: true, expired: false, canRefresh: true },
  }));
}

export async function launchForecastApp(options: ForecastAppOptions): Promise<ForecastApp> {
  const root = await mkdtemp(join(tmpdir(), "codara-usage-forecast-e2e-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(root, "spark-state.json"),
    JSON.stringify({ workspaces: [{ id: "usage", name: "Usage", cwd: workspace, workers: [] }], activeWorkspaceId: "usage" }),
  );
  await writeFile(
    join(root, "spark-preferences.json"),
    JSON.stringify({
      theme: options.theme ?? "codara-classic",
      ...(options.forecast ? {} : { usageForecast: false, usageForecastChosen: true }),
    }),
  );

  const demoDir = process.env.CODARA_FORECAST_DEMO_DIR;
  const data = demoDir
    ? {
        overview: JSON.parse(await readFile(join(demoDir, "overview.json"), "utf8")),
        report: JSON.parse(await readFile(join(demoDir, "report.json"), "utf8")) as UsageForecastReport,
      }
    : syntheticData(Date.now());

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
      const status = () => ({
        runtimeInstalled: true,
        runtimeVersion: "fixture",
        runtimeExpectedVersion: "fixture",
        connections: [],
        systemOffers: {},
        profiles: fixture.rows,
      });
      const channels = ["pi-subscriptions:status", "native-cli-accounts:inspect", "pi-subscriptions:usage"];
      if (fixture.stubForecast) channels.push("usage-forecast:read");
      for (const channel of channels) ipcMain.removeHandler(channel);
      ipcMain.handle("pi-subscriptions:status", status);
      ipcMain.handle("native-cli-accounts:inspect", () => ({
        runtimes: [
          { runtime: "claude", defaultProfileId: null, profiles: [] },
          { runtime: "codex", defaultProfileId: null, profiles: [] },
          { runtime: "grok", defaultProfileId: null, profiles: [] },
        ],
      }));
      ipcMain.handle("pi-subscriptions:usage", () => fixture.overview);
      if (fixture.stubForecast) {
        ipcMain.handle("usage-forecast:read", () => (fixture.forecast ? fixture.report : null));
      }
      for (const contents of webContents.getAllWebContents()) {
        contents.send("pi-subscriptions:event", { type: "usage" });
      }
    },
    {
      rows: accountRows(data.overview as Parameters<typeof accountRows>[0]),
      overview: data.overview,
      report: data.report,
      forecast: options.forecast,
      stubForecast: options.stubForecast ?? true,
    },
  );
  // The renderer read before the stubs existed; a reload reads them fresh.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  return {
    app,
    page,
    close: async () => {
      await app.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
