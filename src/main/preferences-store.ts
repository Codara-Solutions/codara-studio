import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  APP_THEME_IDS,
  DEFAULT_INLINE_AUTOCOMPLETE_DELAY_MS,
  DEFAULT_PREFERENCES,
  EDITOR_THEME_IDS,
  LEGACY_DEFAULT_INLINE_AUTOCOMPLETE_MODEL_IDS,
  type AppPreferences,
  type EditorThemeId,
  type PrefKey,
  type ThemePref,
} from "@shared/types";
import { sparkHome } from "./spark-home";

// Per-user UI preferences (theme + future toggles like vim mode, inline-AI
// model id, etc.). Lives next to spark-state.json / spark-settings.json so
// the existing migration in spark-home.ts covers it implicitly.
const PREFS_FILE = "spark-preferences.json";

let cache: AppPreferences | null = null;
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
  if (
    value === "light" ||
    value === "spark-light" ||
    value === "github-light" ||
    value === "catppuccin-latte" ||
    value === "paper-lantern" ||
    value === "frosted-glass" ||
    value === "sage-terminal" ||
    value === "solar-flare"
  ) {
    return "catppuccin-latte";
  }
  if (
    value === "dark" ||
    value === "system" ||
    value === "spark-dark" ||
    value === "github-dark" ||
    value === "tokyo-night" ||
    value === "nord" ||
    value === "monokai" ||
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
  const path = prefsPath();
  const tmp = path + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(prefs, null, 2), "utf8");
  await fs.rename(tmp, path);
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
  writing = writing.then(() => writeToDisk(next)).catch((err) => {
    console.error("[preferences] write failed:", err);
  });
  await writing;
  return next;
}

export async function flushPreferences(): Promise<void> {
  await writing;
}
