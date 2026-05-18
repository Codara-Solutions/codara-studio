import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  APP_THEME_IDS,
  APP_THEME_MODE,
  DEFAULT_PREFERENCES,
  type ThemeMode,
  type ThemePref,
} from "@shared/types";
import { readAppTokens } from "../lib/theme-tokens";

// Spark uses named workbench themes. The selected theme
// id lives on <html data-theme="..."> so the stylesheet can swap a complete
// token palette. A separate data-theme-mode/class stays available for the few
// consumers that only need to know whether the palette is light or dark.
//
// Sync between windows is handled at the IPC layer (preferences:changed
// broadcast); this provider just listens.

type Theme = ThemePref;

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: Theme;
  themeMode: ThemeMode;
  setTheme: (next: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const FAST_PATH_KEY = "spark-ui-theme-shadow";

function normalizeTheme(value: unknown): Theme {
  if (typeof value !== "string") return DEFAULT_PREFERENCES.theme;
  if ((APP_THEME_IDS as readonly string[]).includes(value)) return value as Theme;
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

function readFastShadow(): Theme {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES.theme;
  try {
    const v = window.localStorage.getItem(FAST_PATH_KEY);
    return normalizeTheme(v);
  } catch {
    /* ignore */
  }
  return DEFAULT_PREFERENCES.theme;
}

function writeFastShadow(t: Theme): void {
  try {
    window.localStorage.setItem(FAST_PATH_KEY, t);
  } catch {
    /* ignore */
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readFastShadow());

  // Hydrate from the persisted preferences (cross-window source of truth).
  useEffect(() => {
    let alive = true;
    void window.spark.preferences.load().then((p) => {
      if (!alive) return;
      const next = normalizeTheme(p.theme);
      setThemeState(next);
      writeFastShadow(next);
    });
    const off = window.spark.preferences.onChanged((change) => {
      if (change.key !== "theme") return;
      const next = normalizeTheme(change.value);
      setThemeState(next);
      writeFastShadow(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const resolvedTheme = theme;
  const themeMode = APP_THEME_MODE[resolvedTheme];

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove(
      "light",
      "dark",
      ...APP_THEME_IDS.map((id) => `theme-${id}`),
    );
    root.classList.add(themeMode, `theme-${resolvedTheme}`);
    root.dataset.theme = resolvedTheme;
    root.dataset.themeMode = themeMode;
    root.style.setProperty("color-scheme", themeMode);
  }, [resolvedTheme, themeMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const frame = window.requestAnimationFrame(() => {
      try {
        const tokens = readAppTokens();
        void window.spark.windowControls.setTitleBarTheme?.({
          color: tokens.panel,
          symbolColor: tokens.foregroundDim,
        });
      } catch {
        /* Title-bar tinting is best-effort and Windows-only. */
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resolvedTheme, themeMode]);

  const setTheme = useCallback((next: Theme) => {
    const normalized = normalizeTheme(next);
    setThemeState(normalized);
    writeFastShadow(normalized);
    void window.spark.preferences
      .set("theme", normalized)
      .then((prefs) => {
        const persisted = normalizeTheme(prefs.theme);
        setThemeState(persisted);
        writeFastShadow(persisted);
      })
      .catch(() => {
        /* Keep the optimistic in-window theme even if persistence fails. */
      });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, themeMode, setTheme }),
    [theme, resolvedTheme, themeMode, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
