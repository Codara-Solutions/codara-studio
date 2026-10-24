// Builds the "Export diagnostics" zip: logs, freeze records, breadcrumbs,
// event-loop windows, the list of crash dumps, app and system details, and
// the settings files, every one of them through redact.ts. Nothing here
// touches Electron, so the unit suite runs it against a fake Codara home.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Breadcrumb, CrashDumpInfo, DiagnosticsSummary, EventLoopWindow, HangRecord } from "@shared/diagnostics";
import { RECENT_WINDOW_MS } from "@shared/diagnostics";
import { listCrashDumps } from "./crash-dumps";
import { redactJson, redactText, type RedactionContext } from "./redact";
import type { ZipEntry } from "./zip";

/** Per file; main.log rotates at 1 MB, so this only trims something unexpected. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export interface DiagnosticsSources {
  /** The Codara home (logs/, settings files). */
  home: string;
  /** <home>/diagnostics */
  diagnosticsDir: string;
  /** <home>/crash-dumps */
  crashDumpsDir: string;
}

export interface BundleInput {
  sources: DiagnosticsSources;
  redaction: RedactionContext;
  system: Record<string, unknown>;
  breadcrumbs: Breadcrumb[];
  eventLoop: EventLoopWindow[];
  now: Date;
}

async function readTail(path: string): Promise<string | null> {
  let handle: import("node:fs").promises.FileHandle | null = null;
  try {
    handle = await fs.open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > length ? `[earlier lines trimmed]\n${text.slice(text.indexOf("\n") + 1)}` : text;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function redactJsonLines(text: string, redaction: RedactionContext): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactJson(JSON.parse(line), redaction));
      } catch {
        return redactText(line, redaction);
      }
    })
    .join("\n");
}

async function redactedJsonFile(path: string, redaction: RedactionContext): Promise<string | null> {
  const text = await readTail(path);
  if (text === null) return null;
  try {
    return pretty(redactJson(JSON.parse(text), redaction));
  } catch {
    return `${redactText(text, redaction)}\n`;
  }
}

const README = (now: Date): string =>
  [
    "Codara Studio diagnostics",
    `Exported ${now.toISOString()}.`,
    "",
    "Before this file was written, tokens, keys, email addresses and home folder",
    "paths were removed (home folders read as ~). Crash dumps are listed by name",
    "and size only; they hold process memory and stay on the computer.",
    "Codara did not upload any of this. Share it only with people you choose.",
    "",
    "system.json                     App, Electron and OS versions, memory, processes",
    "logs/main.log, main.log.1       The main process log",
    "diagnostics/hangs.jsonl         Each time the main process stopped answering",
    "diagnostics/breadcrumbs*.json   Recent notable events, this session and the last",
    "diagnostics/event-loop.json     Main event loop delay, one window a minute",
    "crash-dumps.json                Crash reports kept on this computer",
    "settings/*.json                 Settings and preferences, secrets removed",
    "",
  ].join("\n");

export async function buildDiagnosticsEntries(input: BundleInput): Promise<ZipEntry[]> {
  const { sources, redaction, now } = input;
  const entries: ZipEntry[] = [];
  const add = (name: string, data: string | null): void => {
    if (data !== null) entries.push({ name, data, modifiedAt: now });
  };
  add("README.txt", README(now));
  add("system.json", pretty(redactJson(input.system, redaction)));

  for (const file of ["main.log", "main.log.1"]) {
    const text = await readTail(join(sources.home, "logs", file));
    add(`logs/${file}`, text === null ? null : redactText(text, redaction));
  }
  for (const file of ["hangs.jsonl", "hangs.jsonl.1"]) {
    const text = await readTail(join(sources.diagnosticsDir, file));
    add(`diagnostics/${file}`, text === null ? null : redactJsonLines(text, redaction));
  }
  add(
    "diagnostics/breadcrumbs.json",
    pretty(redactJson({ session: "current", breadcrumbs: input.breadcrumbs }, redaction)),
  );
  add(
    "diagnostics/breadcrumbs.previous.json",
    await redactedJsonFile(join(sources.diagnosticsDir, "breadcrumbs.previous.json"), redaction),
  );
  add("diagnostics/event-loop.json", pretty({ windows: input.eventLoop }));

  const dumps = await listCrashDumps(sources.crashDumpsDir);
  add(
    "crash-dumps.json",
    pretty({
      note: "Minidumps are kept on this computer and are not part of this export.",
      dumps: dumps.map((dump) => ({ ...dump, modifiedAt: new Date(dump.modifiedAt).toISOString() })),
    }),
  );

  for (const file of ["spark-settings.json", "spark-preferences.json"]) {
    add(`settings/${file}`, await redactedJsonFile(join(sources.home, file), redaction));
  }
  return entries;
}

export function diagnosticsFileName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `codara-diagnostics-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

export async function readHangRecords(diagnosticsDir: string): Promise<HangRecord[]> {
  const records: HangRecord[] = [];
  for (const file of ["hangs.jsonl.1", "hangs.jsonl"]) {
    const text = await readTail(join(diagnosticsDir, file));
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as HangRecord;
        if (typeof parsed?.detectedAt === "number" && typeof parsed.durationMs === "number") records.push(parsed);
      } catch {
        // A torn last line from a killed process.
      }
    }
  }
  return records.sort((a, b) => a.detectedAt - b.detectedAt);
}

export function summarizeDiagnostics(
  hangs: HangRecord[],
  dumps: CrashDumpInfo[],
  flags: { watchdog: boolean; crashReporter: boolean },
  now: number,
): DiagnosticsSummary {
  const recent = hangs.filter((hang) => now - hang.detectedAt <= RECENT_WINDOW_MS);
  const last = hangs.length > 0 ? hangs[hangs.length - 1] : null;
  return {
    watchdog: flags.watchdog,
    crashReporter: flags.crashReporter,
    hangs: {
      total: hangs.length,
      recent: recent.length,
      longestRecentMs: recent.length > 0 ? Math.max(...recent.map((hang) => hang.durationMs)) : null,
      last: last ? { at: last.detectedAt, durationMs: last.durationMs, recovered: last.recovered } : null,
    },
    crashes: {
      count: dumps.length,
      bytes: dumps.reduce((sum, dump) => sum + dump.bytes, 0),
      lastAt: dumps.length > 0 ? dumps[0].modifiedAt : null,
    },
  };
}
