import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_PREFERENCES, type ThemePref } from "@shared/types";

// Spark uses a global "system | light | dark" theme. The provider sets a
// `light` or `dark` class on <html> so future stylesheets can target either
// mode. The current Spark UI is dark-only — adding the class now is a
// no-op visually but lets later work introduce a light palette without
// retrofitting every component.
//
// Sync between windows is handled at the IPC layer (preferences:changed
// broadcast); this provider just listens.

type Theme = ThemePref;
type Resolved = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: Resolved;
  setTheme: (next: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const FAST_PATH_KEY = "spark-ui-theme-shadow";

function readFastShadow(): Theme {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES.theme;
  try {
    const v = window.localStorage.getItem(FAST_PATH_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
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
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  // Hydrate from the persisted preferences (cross-window source of truth).
  useEffect(() => {
    let alive = true;
    void window.spark.preferences.load().then((p) => {
      if (!alive) return;
      setThemeState(p.theme);
      writeFastShadow(p.theme);
    });
    const off = window.spark.preferences.onChanged((change) => {
      if (change.key !== "theme") return;
      const v = change.value;
      if (v === "light" || v === "dark" || v === "system") {
        setThemeState(v);
        writeFastShadow(v);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: Resolved =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
    root.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    writeFastShadow(next);
    void window.spark.preferences.set("theme", next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
