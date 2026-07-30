import { createContext, useContext } from "react";
import type { ThemeMode, ThemePref } from "@shared/types";

export interface ThemeContextValue {
  theme: ThemePref;
  resolvedTheme: ThemePref;
  themeMode: ThemeMode;
  setTheme: (next: ThemePref) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
