import type { ThemePref } from "@shared/types";
import { APP_THEME_IDS } from "@shared/types";

// Swatches are bg, panel, accent, ink: enough to draw a tiny window preview
// without loading the theme itself.
const APP_THEME_META: Readonly<
  Record<
    ThemePref,
    {
      label: string;
      mode: "dark" | "light";
      swatches: readonly [string, string, string, string];
    }
  >
> = {
  "codara-classic": {
    label: "Codara Classic",
    mode: "dark",
    swatches: ["#191914", "#25241f", "#f0c419", "#f5f2e9"],
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    mode: "dark",
    swatches: ["#1e1e2e", "#313244", "#89b4fa", "#cdd6f4"],
  },
  dracula: {
    label: "Dracula",
    mode: "dark",
    swatches: ["#282a36", "#44475a", "#bd93f9", "#f8f8f2"],
  },
  "one-dark": {
    label: "One Dark",
    mode: "dark",
    swatches: ["#282c34", "#2c313a", "#61afef", "#abb2bf"],
  },
  "codara-daylight": {
    label: "Codara Daylight",
    mode: "light",
    swatches: ["#faf9f5", "#eae7dd", "#f0c419", "#211f1a"],
  },
  "github-light": {
    label: "GitHub Light",
    mode: "light",
    swatches: ["#ffffff", "#eaeef2", "#0969da", "#1f2328"],
  },
  "rose-pine-dawn": {
    label: "Rosé Pine Dawn",
    mode: "light",
    swatches: ["#faf4ed", "#f2e9e1", "#d7827e", "#575279"],
  },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    mode: "light",
    swatches: ["#f3f5f8", "#dce0e8", "#1e66f5", "#4c4f69"],
  },
};

const GROUPS = (["dark", "light"] as const).map((mode) => ({
  mode,
  label: mode === "dark" ? "Dark" : "Light",
  themes: APP_THEME_IDS.filter((id) => APP_THEME_META[id].mode === mode),
}));

export default function ThemePicker({
  value,
  onChange,
}: {
  value: ThemePref;
  onChange: (next: ThemePref) => void;
}) {
  return (
    <div className="st-themes">
      {GROUPS.map((group) => (
        <div key={group.mode} className="st-themes__group" role="group" aria-label={`${group.label} themes`}>
          <span className="st-themes__label">{group.label}</span>
          <div className="st-themes__grid">
            {group.themes.map((id) => {
              const meta = APP_THEME_META[id];
              const active = value === id;
              const [bg, panel, accent, ink] = meta.swatches;
              return (
                <button
                  key={id}
                  type="button"
                  aria-label={`Use ${meta.label} theme`}
                  aria-pressed={active}
                  className={`st-theme${active ? " is-active" : ""}`}
                  onClick={() => onChange(id)}
                >
                  <span
                    aria-hidden
                    className="st-theme__preview"
                    style={{ background: bg, borderColor: panel }}
                  >
                    <span className="st-theme__side" style={{ background: panel }} />
                    <span className="st-theme__lines">
                      <span style={{ background: ink, opacity: 0.85, width: "78%" }} />
                      <span style={{ background: ink, opacity: 0.4, width: "52%" }} />
                      <span style={{ background: accent, width: "34%" }} />
                    </span>
                  </span>
                  <span className="st-theme__name">
                    {active ? (
                      <svg
                        aria-hidden
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12.5l4.5 4.5L19 7" />
                      </svg>
                    ) : null}
                    {meta.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
