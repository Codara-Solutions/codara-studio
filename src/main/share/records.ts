// This computer's list of the pages it shared: <codara-home>/share/pages.json
// (mode 0600). The service is authoritative for which pages exist and when
// they expire; this file adds what only Studio knows (the file name a page was
// shared from) and keeps the list readable while offline.

import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { SHARE_MAX_TITLE_CHARS, SHARE_PAGE_ID_PATTERN, type SharedPage } from "../../shared/share";
import { fsyncDirSync, stagingPath, writeStagingFileSync } from "../remote-access/identity";
import { ensureShareDir } from "./identity";

export const SHARE_RECORDS_FILE = "pages.json";
const MAX_RECORDS = 1_000;

interface RecordsFile {
  version: 1;
  pages: SharedPage[];
}

export function readShareRecords(shareDir: string): SharedPage[] {
  let raw: string;
  try {
    raw = readFileSync(join(shareDir, SHARE_RECORDS_FILE), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RecordsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.pages)) return [];
    return parsed.pages.filter(isSharedPage);
  } catch {
    return [];
  }
}

export function writeShareRecords(shareDir: string, pages: SharedPage[]): void {
  ensureShareDir(shareDir);
  const file = join(shareDir, SHARE_RECORDS_FILE);
  const payload: RecordsFile = {
    version: 1,
    pages: [...pages].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECORDS),
  };
  const tmp = stagingPath(file);
  writeStagingFileSync(tmp, JSON.stringify(payload, null, 2), 0o600);
  renameSync(tmp, file);
  fsyncDirSync(shareDir);
}

export function upsertShareRecord(shareDir: string, page: SharedPage): void {
  const rest = readShareRecords(shareDir).filter((entry) => entry.id !== page.id);
  writeShareRecords(shareDir, [page, ...rest]);
}

export function removeShareRecord(shareDir: string, id: string): void {
  const records = readShareRecords(shareDir);
  const rest = records.filter((entry) => entry.id !== id);
  if (rest.length !== records.length) writeShareRecords(shareDir, rest);
}

function isSharedPage(value: unknown): value is SharedPage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    SHARE_PAGE_ID_PATTERN.test(v.id) &&
    typeof v.url === "string" &&
    v.url.endsWith(`/p/${v.id}`) &&
    typeof v.title === "string" &&
    v.title.length <= SHARE_MAX_TITLE_CHARS &&
    typeof v.size === "number" &&
    typeof v.createdAt === "number" &&
    typeof v.expiresAt === "number"
  );
}
