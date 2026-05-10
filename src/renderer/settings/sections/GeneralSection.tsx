import type { ThemePref } from "@shared/types";
import { useTheme } from "../../src/theme/ThemeProvider";

const APPEARANCE: ReadonlyArray<{ id: ThemePref; label: string; glyph: string }> = [
  { id: "system", label: "System", glyph: "◐" },
  { id: "light", label: "Light", glyph: "☼" },
  { id: "dark", label: "Dark", glyph: "☾" },
];

export default function GeneralSection() {
  const { theme, setTheme } = useTheme();
  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <h2 className="settings-section-title">General</h2>
        <p className="settings-section-desc">Appearance and global behaviour.</p>
      </header>

      <div>
        <div className="settings-field-label">Appearance</div>
        <div className="settings-theme-grid">
          {APPEARANCE.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className="settings-theme-card"
              data-active={theme === opt.id ? "true" : "false"}
              onClick={() => setTheme(opt.id)}
            >
              <span className="settings-theme-icon" aria-hidden>
                {opt.glyph}
              </span>
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
