import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PREFERENCES,
  EDITOR_THEME_IDS,
  type AppPreferences,
  type EditorThemeId,
  type PrefKey,
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

function normalize(input: Partial<AppPreferences> | null | undefined): AppPreferences {
  const src = input && typeof input === "object" ? input : {};
  const inlineModel =
    typeof src.inlineAutocompleteModelId === "string" && src.inlineAutocompleteModelId.trim()
      ? src.inlineAutocompleteModelId.trim()
      : DEFAULT_PREFERENCES.inlineAutocompleteModelId;
  return {
    theme:
      src.theme === "light" || src.theme === "dark" || src.theme === "system"
        ? src.theme
        : DEFAULT_PREFERENCES.theme,
    vimMode: typeof src.vimMode === "boolean" ? src.vimMode : DEFAULT_PREFERENCES.vimMode,
    editorTheme: isEditorThemeId(src.editorTheme)
      ? src.editorTheme
      : DEFAULT_PREFERENCES.editorTheme,
    inlineAutocompleteEnabled:
      typeof src.inlineAutocompleteEnabled === "boolean"
        ? src.inlineAutocompleteEnabled
        : DEFAULT_PREFERENCES.inlineAutocompleteEnabled,
    inlineAutocompleteModelId: inlineModel,
  };
}

async function readFromDisk(): Promise<AppPreferences> {
  try {
    const raw = await fs.readFile(prefsPath(), "utf8");
    return normalize(JSON.parse(raw) as Partial<AppPreferences>);
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
