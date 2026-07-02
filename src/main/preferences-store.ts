import { readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import {
  APP_THEME_IDS,
  DEFAULT_INLINE_AUTOCOMPLETE_DELAY_MS,
  DEFAULT_NOTIFICATION_CHANNELS,
  DEFAULT_PREFERENCES,
  EDITOR_THEME_IDS,
  LEGACY_DEFAULT_INLINE_AUTOCOMPLETE_MODEL_IDS,
  type AppPreferences,
  type EditorThemeId,
  type NotificationChannelsPref,
  type PrefKey,
  type ThemePref,
} from "@shared/types";
import { writeFileAtomic } from "./fs-atomic";
import { sparkHome } from "./spark-home";

// Per-user UI preferences (theme + future toggles like vim mode, inline-AI
// model id, etc.). Lives next to spark-state.json / spark-settings.json so
// the existing migration in spark-home.ts covers it implicitly.
const PREFS_FILE = "spark-preferences.json";

let cache: AppPreferences | null = null;
// Separate cache for getPreferenceSync(): the sync reader is invoked before
// app.whenReady() so it cannot share the async cache (which is populated by
// loadPreferences() during IPC init). Once filled it is reused across calls
// in the same process, so a single boot only pays one fs.readFileSync.
let syncCache: AppPreferences | null = null;
let writing: Promise<void> = Promise.resolve();

function prefsPath(): string {
  return join(sparkHome(), PREFS_FILE);
}

function isEditorThemeId(value: unknown): value is EditorThemeId {
  return typeof value === "string" && (EDITOR_THEME_IDS as readonly string[]).includes(value);
}

function normalizeTheme(value: unknown): ThemePref {
  if (typeof value !== "string") return DEFAULT_PREFERENCES.theme;
  if ((APP_THEME_IDS as readonly string[]).includes(value)) return value as ThemePref;
  // Legacy / removed light themes collapse to the flagship light palette.
  if (
    value === "light" ||
    value === "spark-light" ||
    value === "paper-lantern" ||
    value === "frosted-glass" ||
    value === "sage-terminal" ||
    value === "solar-flare"
  ) {
    return "spark-daylight";
  }
  // Legacy / removed dark themes (incl. retired Gruvbox / Solarized /
  // Rosé Pine / Everforest / Kanagawa) collapse to Spark Classic.
  if (
    value === "dark" ||
    value === "system" ||
    value === "spark-dark" ||
    value === "github-dark" ||
    value === "tokyo-night" ||
    value === "nord" ||
    value === "monokai" ||
    value === "gruvbox-dark" ||
    value === "solarized-dark" ||
    value === "rose-pine" ||
    value === "everforest" ||
    value === "kanagawa-wave" ||
    value === "ember-forge" ||
    value === "midnight-bloom" ||
    value === "aurora-circuit" ||
    value === "cobalt-harbor" ||
    value === "neon-orchard" ||
    value === "velvet-dusk"
  ) {
    return "spark-classic";
  }
  return DEFAULT_PREFERENCES.theme;
}

function normalizeKeybindings(value: unknown): AppPreferences["keybindings"] {
  if (!value || typeof value !== "object") return {};
  const src = value as Record<string, unknown>;
  const out: AppPreferences["keybindings"] = {};
  for (const [key, raw] of Object.entries(src)) {
    if (raw === null) {
      out[key] = null;
    } else if (typeof raw === "string" && raw.trim()) {
      out[key] = raw;
    }
    // Anything else (numbers, objects, etc.) is silently dropped; the
    // renderer falls back to defaults for that command.
  }
  return out;
}

function normalizeInlineDelay(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_INLINE_AUTOCOMPLETE_DELAY_MS;
  }
  return Math.max(0, Math.min(2_000, Math.round(value)));
}

// Normalize the four-channel notification preferences. Reads the new
// `notificationChannels` blob if present, otherwise falls back to the
// legacy `notifications: { enabled, sounds }` shape from older prefs
// files. Unknown / missing channels resolve to true (on by default) so
// users who skip a Spark version that introduces a new channel get the
// channel auto-enabled instead of silently disabled.
function normalizeNotificationChannels(
  value: unknown,
  legacy: unknown,
): NotificationChannelsPref {
  const defaults = DEFAULT_NOTIFICATION_CHANNELS;
  // Legacy shape: `notifications: { enabled, sounds }`. If `enabled` is
  // explicitly false, the user had alerts switched off — carry that into
  // all four new channels. If `sounds` is explicitly false, keep the
  // sound channel off but leave the rest on.
  let legacyEnabledAll: boolean | undefined;
  let legacySoundsOnly: boolean | undefined;
  if (legacy && typeof legacy === "object") {
    const src = legacy as Record<string, unknown>;
    if (typeof src.enabled === "boolean") legacyEnabledAll = src.enabled;
    if (typeof src.sounds === "boolean") legacySoundsOnly = src.sounds;
  }

  const base: NotificationChannelsPref = legacyEnabledAll === false
    ? { inApp: false, native: false, sound: false, osCues: false }
    : { ...defaults };
  if (legacySoundsOnly === false && legacyEnabledAll !== false) {
    base.sound = false;
  }

  if (!value || typeof value !== "object") {
    return base;
  }
  const src = value as Record<string, unknown>;
  return {
    inApp: typeof src.inApp === "boolean" ? src.inApp : base.inApp,
    native: typeof src.native === "boolean" ? src.native : base.native,
    sound: typeof src.sound === "boolean" ? src.sound : base.sound,
    osCues: typeof src.osCues === "boolean" ? src.osCues : base.osCues,
  };
}

// Validate the per-repo copy-branch setup-command map: string keys → non-empty
// string values. Anything malformed is dropped so a hand-edited prefs file
// cannot inject non-strings.
function normalizeCopyBranchSetupCommands(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [repo, cmd] of Object.entries(value as Record<string, unknown>)) {
    if (typeof repo === "string" && repo.trim() && typeof cmd === "string" && cmd.trim()) {
      out[repo] = cmd;
    }
  }
  return out;
}

function normalize(
  input: Partial<AppPreferences> | null | undefined,
  opts: { migrateLegacyInlineDefault?: boolean } = {},
): AppPreferences {
  const src = input && typeof input === "object" ? input : {};
  const rawInlineModel =
    typeof src.inlineAutocompleteModelId === "string" ? src.inlineAutocompleteModelId.trim() : "";
  const inlineModel =
    opts.migrateLegacyInlineDefault &&
    (LEGACY_DEFAULT_INLINE_AUTOCOMPLETE_MODEL_IDS as readonly string[]).includes(rawInlineModel)
      ? DEFAULT_PREFERENCES.inlineAutocompleteModelId
      : rawInlineModel || DEFAULT_PREFERENCES.inlineAutocompleteModelId;
  return {
    theme: normalizeTheme(src.theme),
    vimMode: typeof src.vimMode === "boolean" ? src.vimMode : DEFAULT_PREFERENCES.vimMode,
    editorTheme: isEditorThemeId(src.editorTheme)
      ? src.editorTheme
      : DEFAULT_PREFERENCES.editorTheme,
    inlineAutocompleteEnabled:
      typeof src.inlineAutocompleteEnabled === "boolean"
        ? src.inlineAutocompleteEnabled
        : DEFAULT_PREFERENCES.inlineAutocompleteEnabled,
    inlineAutocompleteDelayMs: normalizeInlineDelay(src.inlineAutocompleteDelayMs),
    inlineAutocompleteModelId: inlineModel,
    keybindings: normalizeKeybindings(src.keybindings),
    disableHardwareAcceleration:
      typeof src.disableHardwareAcceleration === "boolean"
        ? src.disableHardwareAcceleration
        : DEFAULT_PREFERENCES.disableHardwareAcceleration,
    notificationChannels: normalizeNotificationChannels(
      src.notificationChannels,
      (src as Record<string, unknown>).notifications,
    ),
    notificationsDnd:
      typeof src.notificationsDnd === "boolean"
        ? src.notificationsDnd
        : DEFAULT_PREFERENCES.notificationsDnd,
    keepRunningInBackground:
      typeof src.keepRunningInBackground === "boolean"
        ? src.keepRunningInBackground
        : DEFAULT_PREFERENCES.keepRunningInBackground,
    autoOpenPreview:
      typeof src.autoOpenPreview === "boolean"
        ? src.autoOpenPreview
        : DEFAULT_PREFERENCES.autoOpenPreview,
    copyBranchSetupCommandByRepo: normalizeCopyBranchSetupCommands(
      src.copyBranchSetupCommandByRepo,
    ),
  };
}

async function readFromDisk(): Promise<AppPreferences> {
  try {
    const raw = await fs.readFile(prefsPath(), "utf8");
    return normalize(JSON.parse(raw) as Partial<AppPreferences>, {
      migrateLegacyInlineDefault: true,
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_PREFERENCES };
    }
    console.error("[preferences] failed to read, starting with defaults:", err);
    return { ...DEFAULT_PREFERENCES };
  }
}

async function writeToDisk(prefs: AppPreferences): Promise<void> {
  await writeFileAtomic(prefsPath(), JSON.stringify(prefs, null, 2));
}

export async function loadPreferences(): Promise<AppPreferences> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

export async function setPreference<K extends PrefKey>(
  key: K,
  value: AppPreferences[K],
): Promise<AppPreferences> {
  const current = await loadPreferences();
  const next = normalize({ ...current, [key]: value });
  cache = next;
  // Dual-handle: the awaited `write` rejects to the IPC caller on disk
  // failure so the renderer knows the toggle never persisted, while `writing`
  // swallows the rejection so the queue chain survives for later saves.
  const write = writing.then(() => writeToDisk(next));
  writing = write.catch((err) => {
    console.error("[preferences] write failed:", err);
  });
  await write;
  return next;
}

export async function flushPreferences(): Promise<void> {
  await writing;
}

function readFromDiskSync(): AppPreferences {
  try {
    const raw = readFileSync(prefsPath(), "utf8");
    return normalize(JSON.parse(raw) as Partial<AppPreferences>, {
      migrateLegacyInlineDefault: true,
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_PREFERENCES };
    }
    console.error("[preferences] sync read failed, using defaults:", err);
    return { ...DEFAULT_PREFERENCES };
  }
}

// Synchronously read a single preference. Used before app.whenReady() to
// honour flags Chromium can only consume during process startup (e.g.
// app.disableHardwareAcceleration). Falls back to the default for the key
// when the prefs file is absent (first launch) or unparseable.
export function getPreferenceSync<K extends PrefKey>(key: K): AppPreferences[K] {
  if (!syncCache) {
    syncCache = readFromDiskSync();
  }
  const value = syncCache[key];
  return value === undefined ? DEFAULT_PREFERENCES[key] : value;
}

// Synchronously read a single preference from the LIVE async cache — the same
// `cache` that loadPreferences() fills and setPreference() updates on every
// toggle. Unlike getPreferenceSync (whose separate syncCache never invalidates
// after the first read), this reflects in-session changes immediately. Returns
// the default when the cache hasn't been warmed yet (call loadPreferences()
// during boot to warm it) so callers always get a sensible value.
export function getPreferenceCached<K extends PrefKey>(key: K): AppPreferences[K] {
  if (!cache) return DEFAULT_PREFERENCES[key];
  const value = cache[key];
  return value === undefined ? DEFAULT_PREFERENCES[key] : value;
}
