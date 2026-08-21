// Cora Board model — the pure card/board logic for the PER-CHAT kanban.
//
// The board itself now lives on RunState.board and is persisted by run-store
// through commitRunChange (exactly like the whiteboard), so this module holds
// no storage of its own. It owns three things:
//
//   1. Normalization: coercing untrusted card lists (renderer IPC payloads,
//      hand-edited run.json, older builds) into the BoardCard shape, with the
//      server-owned fields (createdBy, workerTaskId, legacy runId, imagePaths
//      on agent writes) carried over from the stored cards rather than trusted
//      from the payload.
//   2. The user-side apply: `applyUserBoardUpdate` builds the next card list
//      for a renderer write. The revision guard itself lives in run-store's
//      commit (the store is the only place the current revision is
//      authoritative).
//   3. Legacy adoption: reading the retired per-WORKSPACE board files under
//      codaraHome()/boards so a chat opening its empty board can adopt the old
//      cards exactly once. The legacy files are never rewritten; a sidecar
//      `<file>.adopted.json` marks which run took them.
//
// This module never imports run-store, so run-store can import it freely.

import { app } from "electron";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BoardCard, BoardCardStatus, RunBoard } from "@shared/types";
import { writeFileAtomic } from "../fs-atomic";
import { codaraHome } from "../codara-home";

// Caps on card text and volume so one runaway write can't bloat run.json into
// something the renderer chokes on.
export const BOARD_MAX_CARDS = 500;
export const BOARD_MAX_TITLE_LENGTH = 300;
export const BOARD_MAX_DESCRIPTION_LENGTH = 8000;
export const BOARD_MAX_ERROR_LENGTH = 2000;
const MAX_IMAGES_PER_CARD = 8;
const MAX_IMAGE_PATH_LENGTH = 1024;

export const BOARD_CARD_STATUSES: ReadonlySet<string> = new Set<BoardCardStatus>([
  "idea",
  "queued",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
]);

export function emptyRunBoard(): RunBoard {
  return { revision: 0, cards: [] };
}

// ── Validation helpers ──────────────────────────────────────────────────────

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

// Directory the renderer writes pasted images into (see the
// attachments:savePastedImage IPC handler, which builds the identical path).
// Resolved lazily and cached: app.getPath throws before the app is ready, and
// this module is imported at boot.
let pastedImagesDirCache: string | null = null;
function pastedImagesDir(): string | null {
  if (pastedImagesDirCache) return pastedImagesDirCache;
  try {
    pastedImagesDirCache = join(app.getPath("userData"), "pasted-images");
  } catch {
    return null;
  }
  return pastedImagesDirCache;
}

/** True when `candidate` resolves to a location at or beneath `root`. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Card image attachments are forwarded to workers, which read them off disk —
 * so an unconstrained path here is an arbitrary-file-read primitive. Keep them
 * to the two places a legitimate card image comes from: inside the workspace
 * itself, or the app's pasted-images directory. Violations are dropped, not
 * rejected, so one bad path can't fail an otherwise valid board write.
 */
function sanitizeImagePaths(raw: unknown, workspaceCwd: string | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const pasted = pastedImagesDir();
  const kept: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const value = entry.trim();
    if (!value || value.length > MAX_IMAGE_PATH_LENGTH) continue;
    if (!isAbsolute(value)) continue;
    const resolved = resolve(value);
    const allowed =
      (workspaceCwd ? isInside(workspaceCwd, resolved) : false) ||
      (pasted ? isInside(pasted, resolved) : false);
    if (!allowed) {
      console.debug(`[board] dropping out-of-bounds card image path: ${value}`);
      continue;
    }
    kept.push(resolved);
    if (kept.length >= MAX_IMAGES_PER_CARD) break;
  }
  return kept;
}

/**
 * Context normalizeBoardCards needs beyond the raw list: the workspace
 * directory image paths are constrained to, and the cards as currently stored
 * (so server-owned fields are carried over rather than trusted from the
 * incoming payload). `stampAuthor` is the provenance written onto NEW cards.
 */
export interface BoardNormalizeContext {
  workspaceCwd?: string;
  existingById?: Map<string, BoardCard>;
  stampAuthor?: BoardCard["createdBy"];
  /**
   * Worker-task ids the payload is allowed to stamp onto cards (the agent
   * path passes this run's task ids; validation against the live run happens
   * at the commit). Absent — the user path — payload workerTaskId is ignored
   * and the stored value carries over.
   */
  acceptWorkerTaskIds?: ReadonlySet<string>;
  /**
   * When true (the user path), an omitted or empty description/error on an
   * existing card keeps the stored text — the renderer round-trips whole
   * cards and must never strip a body it didn't edit. The agent path leaves
   * this off: authorizeAgentBoardWrite already resolved keep-vs-clear, so its
   * output is authoritative and an absent field really is cleared.
   */
  carryMissingText?: boolean;
}

/**
 * Coerce one untrusted card into the BoardCard shape, dropping unknown fields.
 * Returns null for anything without a usable id and title — a card the user
 * can neither see nor address is worse than a dropped one. `fallbackOrder`
 * backfills a missing order with the card's position in the incoming list.
 *
 * Server-owned fields are NEVER read from the incoming payload for existing
 * cards: createdBy proves who authored the card (the delete permission hangs
 * off it), workerTaskId is validated at the agent boundary, and runId is the
 * legacy link to a retired per-card run. All three are carried over from the
 * stored card by id.
 */
function normalizeBoardCard(
  raw: unknown,
  fallbackOrder: number,
  now: string,
  context: BoardNormalizeContext,
): BoardCard | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;

  const id = clampText(source.id, 200);
  const title = clampText(source.title, BOARD_MAX_TITLE_LENGTH);
  if (!id || !title) return null;

  const status =
    typeof source.status === "string" && BOARD_CARD_STATUSES.has(source.status)
      ? (source.status as BoardCardStatus)
      : "idea";

  const existing = context.existingById?.get(id);

  const card: BoardCard = {
    id,
    title,
    status,
    order:
      typeof source.order === "number" && Number.isFinite(source.order)
        ? source.order
        : fallbackOrder,
    createdAt: existing?.createdAt ?? clampText(source.createdAt, 64) ?? now,
    updatedAt: clampText(source.updatedAt, 64) ?? now,
  };

  const description =
    clampText(source.description, BOARD_MAX_DESCRIPTION_LENGTH) ??
    (context.carryMissingText ? existing?.description : undefined);
  if (description) card.description = description;

  // Images: paths in the payload are validated against the workspace/pasted
  // dirs; an existing card whose payload omits the field keeps its stored
  // attachments (so writers that round-trip cards untouched can't strip them).
  const requested = Array.isArray(source.imagePaths)
    ? sanitizeImagePaths(source.imagePaths, context.workspaceCwd)
    : undefined;
  const images = requested ?? existing?.imagePaths ?? [];
  if (images.length > 0) card.imagePaths = images;

  // Server-owned: carried over from the stored card, never taken from input —
  // except workerTaskId, which the agent path may stamp with a validated id.
  const payloadTaskId = clampText(source.workerTaskId, 200);
  if (payloadTaskId && context.acceptWorkerTaskIds?.has(payloadTaskId)) {
    card.workerTaskId = payloadTaskId;
  } else if (existing?.workerTaskId) {
    card.workerTaskId = existing.workerTaskId;
  }
  if (existing) {
    if (existing.runId) card.runId = existing.runId;
    if (existing.createdBy) card.createdBy = existing.createdBy;
  } else if (context.stampAuthor) {
    card.createdBy = context.stampAuthor;
  }

  const error =
    clampText(source.error, BOARD_MAX_ERROR_LENGTH) ??
    (context.carryMissingText ? existing?.error : undefined);
  if (error) card.error = error;

  return card;
}

/** Normalize a whole card list: drop invalid entries, dedupe ids, cap length. */
export function normalizeBoardCards(
  raw: unknown,
  context: BoardNormalizeContext = {},
): BoardCard[] {
  if (!Array.isArray(raw)) return [];
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const cards: BoardCard[] = [];
  for (const [index, entry] of raw.entries()) {
    const card = normalizeBoardCard(entry, index, now, context);
    if (!card) continue;
    // First occurrence wins. A duplicated id is a client bug; picking a
    // deterministic winner keeps the result stable.
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
    if (cards.length >= BOARD_MAX_CARDS) break;
  }
  return cards;
}

/**
 * Coerce a board read back from run.json (normalizeRun's read/write edges).
 * Reading our own file back: server-owned fields are already trusted data
 * here, so they are restored rather than dropped. Everything else is still
 * re-validated in case the file was hand-edited or written by an older build.
 */
export function normalizeStoredRunBoard(raw: unknown): RunBoard | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const stored = Array.isArray(source.cards) ? source.cards : [];
  const existingById = new Map<string, BoardCard>();
  for (const entry of stored) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = clampText(record.id, 200);
    if (!id) continue;
    const carried: Partial<BoardCard> = {};
    const runId = clampText(record.runId, 200);
    if (runId) carried.runId = runId;
    const workerTaskId = clampText(record.workerTaskId, 200);
    if (workerTaskId) carried.workerTaskId = workerTaskId;
    if (record.createdBy === "agent" || record.createdBy === "user") {
      carried.createdBy = record.createdBy;
    }
    const createdAt = clampText(record.createdAt, 64);
    if (createdAt) carried.createdAt = createdAt;
    // Stored image paths were validated on write; restore without re-checking
    // the (unknown at read time) workspace cwd.
    if (Array.isArray(record.imagePaths)) {
      const paths = record.imagePaths
        .filter(
          (p): p is string =>
            typeof p === "string" && p.length > 0 && p.length <= MAX_IMAGE_PATH_LENGTH,
        )
        .slice(0, MAX_IMAGES_PER_CARD);
      if (paths.length > 0) carried.imagePaths = paths;
    }
    existingById.set(id, carried as BoardCard);
  }
  // imagePaths were validated against the workspace on write; at read time the
  // cwd is unknown, so strip the field from the payload and let the carry-over
  // restore the stored (trusted) paths instead of re-validating them away.
  const withoutImages = stored.map((entry) =>
    entry && typeof entry === "object"
      ? { ...(entry as Record<string, unknown>), imagePaths: undefined }
      : entry,
  );
  return {
    revision:
      typeof source.revision === "number" && Number.isFinite(source.revision)
        ? Math.max(0, Math.floor(source.revision))
        : 0,
    cards: normalizeBoardCards(withoutImages, { existingById }),
  };
}

/**
 * Build the next card list for a USER (renderer IPC) write. The user has full
 * card powers — create in any lane, move, edit, delete — but the server-owned
 * fields still come from the stored cards, and new cards are stamped
 * createdBy "user".
 */
export function applyUserBoardUpdate(
  current: RunBoard,
  cards: unknown,
  workspaceCwd: string | undefined,
): BoardCard[] {
  return normalizeBoardCards(cards, {
    workspaceCwd,
    existingById: new Map(current.cards.map((card) => [card.id, card])),
    stampAuthor: "user",
    carryMissingText: true,
  });
}

// ── Board nudge note ────────────────────────────────────────────────────────

/**
 * The synthetic note run-store's nudge injects when queued cards are handed to
 * the chat's manager. WORDING IS LOAD-BEARING: the note is delivered as a
 * user-authored turn, and run-store's plan-rewrite heuristics
 * (user-intent.ts hasExplicitParallelAgentIntent) key on phrases like
 * "spawn ... workers" and "parallel" in user text. Those heuristics skip
 * boardNote messages at the root, but the instruction sentence still avoids
 * the trigger vocabulary so a copy of it (a compaction summary, a quote in a
 * reply) can never arm them either. Pinned by scripts/test-board-nudge.cjs.
 */
export function composeBoardNudgeMessage(cards: BoardCard[]): string {
  const shown = cards.slice(0, 20);
  const lines = shown.map((card) => `- "${card.title}" (card ${card.id})`);
  const extra = cards.length > shown.length ? `\n...and ${cards.length - shown.length} more.` : "";
  const lead =
    cards.length === 1
      ? "[Cora Board] A card is queued on this chat's board:"
      : `[Cora Board] ${cards.length} cards are queued on this chat's board:`;
  return (
    `${lead}\n${lines.join("\n")}${extra}\n\n` +
    "Read the board with codara_board_get, enrich each queued card into a well scoped brief, " +
    "delegate the cards with codara_spawn_workers (independently where possible), and keep the " +
    "card lanes updated with codara_board_update as the work progresses."
  );
}

// ── Legacy workspace-board adoption ─────────────────────────────────────────
// The retired board engine kept one JSON file per workspace under
// codaraHome()/boards. Those files stay on disk untouched; the first chat that
// opens an empty board in that workspace adopts the cards ONCE, marked by a
// sidecar file so a second chat doesn't adopt them again.

function boardsRoot(): string {
  return join(codaraHome(), "boards");
}

// Mirrors the retired store's file naming exactly so the legacy files resolve.
function sanitizeWorkspaceId(workspaceId: string): string {
  const cleaned = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_");
  const digest = createHash("sha1").update(workspaceId).digest("hex").slice(0, 8);
  const stem = cleaned.length > 0 ? cleaned.slice(0, 180) : "_unknown";
  return `${stem}-${digest}`;
}

function legacyBoardPath(workspaceId: string): string {
  return join(boardsRoot(), `${sanitizeWorkspaceId(workspaceId)}.json`);
}

function adoptionMarkerPath(workspaceId: string): string {
  return join(boardsRoot(), `${sanitizeWorkspaceId(workspaceId)}.adopted.json`);
}

/**
 * Map a legacy card into the per-chat model. Settled lanes (idea, review,
 * done, failed) carry over as-is. The live lanes (queued, running, blocked)
 * belonged to the retired engine's run-per-card lifecycle — adopting them
 * as-is would either instantly nudge this chat's Cora into work the user
 * queued under different semantics, or show "running" with nothing running —
 * so they land back in "idea" with a note saying where they came from. The
 * legacy runId is kept so the card can still open its old run's chat.
 */
function adoptLegacyCard(card: BoardCard): BoardCard {
  const adopted: BoardCard = { ...card };
  if (card.status === "queued" || card.status === "running" || card.status === "blocked") {
    adopted.status = "idea";
    adopted.error = "Adopted from the old workspace board; queue it again to run it here";
  }
  delete adopted.workerTaskId;
  delete adopted.createdBy; // absent reads as "user" — legacy cards are the user's
  return adopted;
}

export interface LegacyBoardAdoption {
  cards: BoardCard[];
}

/**
 * The legacy workspace board's cards, ready for adoption into a run — or null
 * when there is nothing to adopt: no legacy file, an empty/corrupt one, or a
 * board already adopted by some run.
 */
export async function readLegacyBoardForAdoption(
  workspaceId: string,
): Promise<LegacyBoardAdoption | null> {
  try {
    await fs.access(adoptionMarkerPath(workspaceId));
    return null; // already adopted
  } catch {
    /* no marker — fall through */
  }
  let raw: string;
  try {
    raw = await fs.readFile(legacyBoardPath(workspaceId), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const stored = normalizeStoredRunBoard(parsed);
    if (!stored || stored.cards.length === 0) return null;
    return { cards: stored.cards.map(adoptLegacyCard) };
  } catch (err) {
    console.warn(`[board] unreadable legacy board for ${workspaceId}; skipping adoption:`, err);
    return null;
  }
}

/**
 * Claim the legacy board for `runId`. Written BEFORE the adopting commit so a
 * concurrent second chat can't double-adopt; the caller clears the marker if
 * its commit then fails.
 */
export async function markLegacyBoardAdopted(
  workspaceId: string,
  runId: string,
): Promise<void> {
  await fs.mkdir(boardsRoot(), { recursive: true });
  await writeFileAtomic(
    adoptionMarkerPath(workspaceId),
    `${JSON.stringify({ workspaceId, runId, adoptedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

/** Best-effort rollback for a failed adopting commit. */
export async function clearLegacyBoardAdoption(workspaceId: string): Promise<void> {
  try {
    await fs.unlink(adoptionMarkerPath(workspaceId));
  } catch {
    /* marker never landed, or already gone */
  }
}
