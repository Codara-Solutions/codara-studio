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

// Codara uses named workbench themes. The selected theme
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
  // Legacy / removed light themes (incl. the pre-rename spark-daylight and
  // cora-daylight ids) collapse to the flagship light palette.
  if (
    value === "light" ||
    value === "spark-light" ||
    value === "spark-daylight" ||
    value === "cora-daylight" ||
    value === "paper-lantern" ||
    value === "frosted-glass" ||
    value === "sage-terminal" ||
    value === "solar-flare"
  ) {
    return "codara-daylight";
  }
  // Legacy / removed dark themes (incl. the pre-rename spark-classic and
  // cora-classic ids and retired Gruvbox / Solarized / Rosé Pine / Everforest /
  // Kanagawa) collapse to Codara Classic.
  if (
    value === "dark" ||
    value === "system" ||
    value === "spark-dark" ||
    value === "spark-classic" ||
    value === "cora-classic" ||
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
    return "codara-classic";
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

// Liquid-glass kill switch: every glass rule in styles.css is gated on
// html:not([data-glass="off"]), so flipping the attribute reverts the whole
// app to opaque surfaces without touching component styles.
function applyGlassAttr(enabled: boolean): void {
  document.documentElement.dataset.glass = enabled ? "on" : "off";
}

// Liquid-glass tuning (Settings → Appearance), percentages of the design
// default. Veil/blur ride CSS scale vars consumed by the --glass-* tokens;
// refraction/chroma become the scale attributes of the three per-channel
// feDisplacementMap primitives in #codara-glass-lens (index.html): center bend
// 58px at 100%, ±13px channel spread for the chromatic fringe.
const GLASS_TUNING_KEYS = ["glassVeil", "glassBlur", "glassRefraction", "glassChroma"] as const;
type GlassTuningKey = (typeof GLASS_TUNING_KEYS)[number];
const glassTuning: Record<GlassTuningKey, number> = {
  glassVeil: 100,
  glassBlur: 100,
  glassRefraction: 100,
  glassChroma: 100,
};

function asGlassFactor(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(200, value)) / 100
    : 1;
}

function applyGlassTuning(): void {
  const style = document.documentElement.style;
  style.setProperty("--glass-veil-scale", String(asGlassFactor(glassTuning.glassVeil)));
  style.setProperty("--glass-blur-scale", String(asGlassFactor(glassTuning.glassBlur)));
  const center = 58 * asGlassFactor(glassTuning.glassRefraction);
  const spread = center > 0 ? 13 * asGlassFactor(glassTuning.glassChroma) : 0;
  const scales = [center + spread, center, Math.max(0, center - spread)];
  document
    .querySelectorAll("#codara-glass-lens feDisplacementMap")
    .forEach((node, i) => node.setAttribute("scale", String(scales[i] ?? center)));
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
      applyGlassAttr(p.glassEffects !== false);
      for (const key of GLASS_TUNING_KEYS) {
        const v = p[key];
        if (typeof v === "number" && Number.isFinite(v)) glassTuning[key] = v;
      }
      applyGlassTuning();
    });
    const off = window.spark.preferences.onChanged((change) => {
      if (change.key === "glassEffects") {
        applyGlassAttr(change.value !== false);
        return;
      }
      if ((GLASS_TUNING_KEYS as readonly string[]).includes(change.key)) {
        const v = change.value;
        if (typeof v === "number" && Number.isFinite(v)) {
          glassTuning[change.key as GlassTuningKey] = v;
          applyGlassTuning();
        }
        return;
      }
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
