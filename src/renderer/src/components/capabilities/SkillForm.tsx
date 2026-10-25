import React from "react";
import {
  Field,
  formErrorStyle,
  optionalStyle,
  panelStyle,
  rowNoteStyle,
  sectionStyle,
  smallBtnStyle,
  textareaStyle,
} from "./controls";

// The "Add skill" view. Writing a skill and importing one both land in
// Codara's own skill folder, which Cora and its workers load per launch; no
// CLI's skill folder is touched.
export type SkillSource = "folder" | "zip" | "git";

export interface SkillEditorState {
  mode: "create" | "import";
  name: string;
  description: string;
  instructions: string;
  source: SkillSource;
  path: string;
  url: string;
  // Set when the import source held several skills: their folders, relative
  // to the source, for the user to pick from.
  candidates: string[] | null;
}

export function blankSkillEditor(): SkillEditorState {
  return {
    mode: "create",
    name: "",
    description: "",
    instructions: "",
    source: "folder",
    path: "",
    url: "",
    candidates: null,
  };
}

// Mirrors SKILL_NAME_PATTERN in src/main/skill-import.ts, which the renderer
// cannot import. The main process stays the authority.
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function validateSkillEditor(editor: SkillEditorState): string | null {
  if (editor.mode === "create") {
    const name = editor.name.trim();
    if (!name) return "Name is required.";
    if (!SKILL_NAME_PATTERN.test(name)) {
      return "Name may use lowercase letters, digits and hyphens, and must start and end with a letter or digit.";
    }
    if (!editor.description.trim()) return "A description is required: it is how Cora decides when to load the skill.";
    if (!editor.instructions.trim()) return "Write the instructions the agent should follow.";
    return null;
  }
  if (editor.source === "git") {
    const url = editor.url.trim();
    if (!url) return "Paste the repository's https:// address.";
    if (!/^https:\/\//i.test(url)) return "Only https:// repository addresses can be imported.";
    return null;
  }
  if (!editor.path.trim()) return editor.source === "zip" ? "Choose the zip file to import." : "Choose the skill's folder.";
  return null;
}

const SOURCES: { id: SkillSource; label: string }[] = [
  { id: "folder", label: "Folder" },
  { id: "zip", label: "Zip file" },
  { id: "git", label: "Git repository" },
];

export default function SkillForm({
  editor,
  busy,
  error,
  onChange,
  onPickFolder,
  onPickZip,
  onChooseCandidate,
}: {
  editor: SkillEditorState;
  busy: boolean;
  error: string | null;
  onChange: (next: SkillEditorState) => void;
  onPickFolder: () => void;
  onPickZip: () => void;
  onChooseCandidate: (subdir: string) => void;
}) {
  const set = <K extends keyof SkillEditorState>(key: K, value: SkillEditorState[K]) =>
    onChange({ ...editor, [key]: value, candidates: key === "candidates" ? (value as string[] | null) : null });
  return (
    <section style={sectionStyle} aria-busy={busy}>
      <div style={formGridStyle}>
        <div className="spark-segmented" role="group" aria-label="How to add the skill">
          <button
            type="button"
            className={editor.mode === "create" ? "spark-segmented-item is-selected" : "spark-segmented-item"}
            aria-pressed={editor.mode === "create"}
            onClick={() => set("mode", "create")}
          >
            Write a skill
          </button>
          <button
            type="button"
            className={editor.mode === "import" ? "spark-segmented-item is-selected" : "spark-segmented-item"}
            aria-pressed={editor.mode === "import"}
            onClick={() => set("mode", "import")}
          >
            Import one
          </button>
        </div>

        {editor.mode === "create" ? (
          <>
            <Field label="Name" hint="Lowercase letters, digits and hyphens, like release-checklist. It names the skill's folder.">
              <input
                className="spark-input spark-mono"
                value={editor.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="release-checklist"
                spellCheck={false}
                autoFocus
                aria-label="Skill name"
              />
            </Field>
            <Field label="Description" hint="When an agent should use it. Cora reads this line to decide whether to load the skill.">
              <textarea
                className="spark-input"
                value={editor.description}
                onChange={(event) => set("description", event.target.value)}
                placeholder="Use when preparing a release: version bump, changelog, tag and publish steps."
                rows={2}
                style={textareaStyle}
                aria-label="Skill description"
              />
            </Field>
            <Field label={<>Instructions <span style={optionalStyle}>Markdown</span></>}>
              <textarea
                className="spark-input spark-mono"
                value={editor.instructions}
                onChange={(event) => set("instructions", event.target.value)}
                placeholder={"# Release checklist\n\n1. Run the full test suite.\n2. Update CHANGELOG.md.\n3. ..."}
                spellCheck={false}
                rows={14}
                style={{ ...textareaStyle, minHeight: 220, fontSize: 12.5, lineHeight: 1.5 }}
                aria-label="Skill instructions"
              />
            </Field>
          </>
        ) : (
          <>
            <div className="spark-segmented" role="group" aria-label="Import from">
              {SOURCES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={editor.source === option.id ? "spark-segmented-item is-selected" : "spark-segmented-item"}
                  aria-pressed={editor.source === option.id}
                  onClick={() => set("source", option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {editor.source === "git" ? (
              <Field
                label="Repository address"
                hint="An https:// address. A GitHub or GitLab link to a folder imports the skill in that folder."
              >
                <input
                  className="spark-input spark-mono"
                  value={editor.url}
                  onChange={(event) => set("url", event.target.value)}
                  placeholder="https://github.com/owner/skills/tree/main/release-checklist"
                  spellCheck={false}
                  autoFocus
                  aria-label="Repository address"
                />
              </Field>
            ) : (
              <Field
                label={editor.source === "zip" ? "Zip file" : "Folder"}
                hint={
                  editor.source === "zip"
                    ? "A zip holding a folder with a SKILL.md. Entries that would land outside it are refused."
                    : "The skill's folder, the one with SKILL.md in it. It is copied; the original stays where it is."
                }
              >
                <div style={pathRowStyle}>
                  <input
                    className="spark-input spark-mono"
                    value={editor.path}
                    onChange={(event) => set("path", event.target.value)}
                    placeholder={editor.source === "zip" ? "/path/to/skill.zip" : "/path/to/skill"}
                    spellCheck={false}
                    aria-label={editor.source === "zip" ? "Zip file path" : "Folder path"}
                  />
                  <button
                    type="button"
                    className="spark-btn"
                    style={smallBtnStyle}
                    onClick={editor.source === "zip" ? onPickZip : onPickFolder}
                    disabled={busy}
                  >
                    Choose
                  </button>
                </div>
              </Field>
            )}
            {editor.candidates && editor.candidates.length > 0 ? (
              <div style={panelStyle} role="group" aria-label="Skills in this source">
                <span style={rowNoteStyle}>This source holds {editor.candidates.length} skills. Which one?</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {editor.candidates.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      className="spark-btn"
                      style={smallBtnStyle}
                      disabled={busy}
                      onClick={() => onChooseCandidate(candidate)}
                    >
                      {candidate}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}

        <span style={rowNoteStyle}>
          Saved in Codara's own skill folder. Cora and its workers load it from their next launch; switch it off in
          the list any time.
        </span>

        {error ? (
          <div role="alert" style={formErrorStyle}>
            {error}
          </div>
        ) : null}
      </div>
    </section>
  );
}

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gap: 16,
  maxWidth: 640,
};

const pathRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 6,
  alignItems: "center",
};
