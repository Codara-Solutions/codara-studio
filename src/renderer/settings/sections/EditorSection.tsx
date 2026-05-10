import {
  EDITOR_THEME_IDS,
  type EditorThemeId,
} from "@shared/types";
import { usePreferences } from "../../src/preferences/usePreferences";

const THEME_LABEL: Record<EditorThemeId, string> = {
  atomone: "Atom One",
  aura: "Aura",
  copilot: "Copilot",
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  nord: "Nord",
  "tokyo-night": "Tokyo Night",
  "xcode-dark": "Xcode Dark",
  "xcode-light": "Xcode Light",
};

export default function EditorSection() {
  const { preferences, hydrated, setPreference } = usePreferences();

  if (!hydrated) {
    return (
      <section className="settings-section">
        <header className="settings-section-header">
          <h2 className="settings-section-title">Editor</h2>
          <p className="settings-section-desc">Code-editing behaviour.</p>
        </header>
        <div className="settings-placeholder">Loading preferences...</div>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <h2 className="settings-section-title">Editor</h2>
        <p className="settings-section-desc">Code-editing behaviour.</p>
      </header>

      <ToggleRow
        title="Vim mode"
        desc="Modal editing with :w / :q / :wq / :x ex-commands."
        checked={preferences.vimMode}
        onChange={(v) => void setPreference("vimMode", v)}
      />

      <div>
        <div className="settings-field-label">Editor theme</div>
        <select
          className="settings-select"
          value={preferences.editorTheme}
          onChange={(e) => void setPreference("editorTheme", e.target.value as EditorThemeId)}
        >
          {EDITOR_THEME_IDS.map((id) => (
            <option key={id} value={id}>
              {THEME_LABEL[id]}
            </option>
          ))}
        </select>
      </div>

      <ToggleRow
        title="Inline AI autocomplete"
        desc="Ghost-text suggestions as you type. Tab to accept, Esc to dismiss, Alt+\ to trigger manually."
        checked={preferences.inlineAutocompleteEnabled}
        onChange={(v) => void setPreference("inlineAutocompleteEnabled", v)}
      />

      <div>
        <div className="settings-field-label">Inline AI model</div>
        <input
          className="settings-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={preferences.inlineAutocompleteModelId}
          placeholder="x-ai/grok-code-fast-1"
          onChange={(e) => void setPreference("inlineAutocompleteModelId", e.target.value)}
        />
        <div className="settings-field-help">
          OpenRouter model id, e.g. <code>x-ai/grok-code-fast-1</code>. Reuses the
          OpenRouter API key configured for the orchestrator.
        </div>
      </div>
    </section>
  );
}

function ToggleRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-title">{title}</div>
        <div className="settings-row-desc">{desc}</div>
      </div>
      <button
        type="button"
        className="settings-switch"
        data-on={checked ? "true" : "false"}
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
      >
        <span className="settings-switch-thumb" />
      </button>
    </div>
  );
}
