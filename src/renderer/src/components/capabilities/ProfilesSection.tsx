import type React from "react";
import type { CoraProfile } from "@shared/types";
import {
  ConfirmRemoveButton,
  Field,
  SectionHead,
  formErrorStyle,
  listStyle,
  optionalStyle,
  panelStyle,
  rowActionsStyle,
  rowNameStyle,
  rowNoteStyle,
  rowStyle,
  sectionStyle,
  smallBtnStyle,
  textareaStyle,
  badgeStyle,
} from "./controls";

// PROFILE_INSTRUCTIONS_MAX_CHARS in src/main/orchestration/cora-profiles.ts.
export const PROFILE_MAX_CHARS = 4000;

export interface ProfileDraft {
  name: string;
  description: string;
  instructions: string;
}

export interface ProfileDocumentDraft {
  profileId: string;
  content: string;
  original: string;
  revision: string;
}

export default function ProfilesSection({
  profiles,
  loading,
  operation,
  draft,
  onDraftChange,
  onCreate,
  onMakeDefault,
  onDelete,
  onShowMemory,
  documentDraft,
  documentBusy,
  documentError,
  onEditDocument,
  onDocumentChange,
  onSaveDocument,
  onCancelDocument,
  focusProfileId,
}: {
  profiles: CoraProfile[];
  loading: boolean;
  operation: "switching" | "creating" | "deleting" | null;
  draft: ProfileDraft;
  onDraftChange: (next: ProfileDraft) => void;
  onCreate: () => void;
  onMakeDefault: (profile: CoraProfile) => void;
  onDelete: (profile: CoraProfile) => void;
  onShowMemory: (profile: CoraProfile) => void;
  documentDraft: ProfileDocumentDraft | null;
  documentBusy: boolean;
  documentError: string | null;
  onEditDocument: (profile: CoraProfile) => void;
  onDocumentChange: (content: string) => void;
  onSaveDocument: () => void;
  onCancelDocument: () => void;
  focusProfileId: string | null;
}) {
  const busy = operation !== null;
  return (
    <section style={sectionStyle}>
      <SectionHead
        detail={
          <>
            A profile is a separate Cora with its own instructions and its own memory. Pick one for each
            new chat from the profile menu in the Cora composer; a chat keeps the profile it started with.
            The default is what new chats and automations use when you do not pick one.
          </>
        }
      />

      <div className="agent-capability-list" style={listStyle} aria-busy={loading}>
        {profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            busy={busy}
            highlighted={profile.id === focusProfileId}
            editing={documentDraft?.profileId === profile.id ? documentDraft : null}
            documentBusy={documentBusy}
            documentError={documentDraft?.profileId === profile.id ? documentError : null}
            onMakeDefault={onMakeDefault}
            onDelete={onDelete}
            onShowMemory={onShowMemory}
            onEditDocument={onEditDocument}
            onDocumentChange={onDocumentChange}
            onSaveDocument={onSaveDocument}
            onCancelDocument={onCancelDocument}
          />
        ))}
        {loading && profiles.length === 0 ? (
          <div style={{ ...rowStyle, ...rowNoteStyle }} role="status">
            Reading profiles
          </div>
        ) : null}
      </div>

      <form
        // The list's closing rule already divides the two.
        style={{ ...panelStyle, borderTop: "none", paddingTop: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          onCreate();
        }}
        aria-label="Create a profile"
      >
        <div style={{ display: "grid", gap: 3 }}>
          <h3 style={formTitleStyle}>Make another Cora</h3>
          <span style={rowNoteStyle}>
            For example a careful reviewer, or a designer who only touches the UI. Its memory starts empty
            and stays separate from every other profile.
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <div style={{ flex: "1 1 180px", minWidth: 0 }}>
            <Field label="Name">
              <input
                className="spark-input"
                value={draft.name}
                maxLength={80}
                placeholder="e.g. Reviewer"
                disabled={busy}
                onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
              />
            </Field>
          </div>
          <div style={{ flex: "2 1 260px", minWidth: 0 }}>
            <Field label={<>Purpose <span style={optionalStyle}>optional</span></>}>
              <input
                className="spark-input"
                value={draft.description}
                maxLength={300}
                placeholder="What should this Cora focus on?"
                disabled={busy}
                onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
              />
            </Field>
          </div>
        </div>
        <Field
          label={<>Instructions <span style={optionalStyle}>optional</span></>}
          hint={`${draft.instructions.length} / ${PROFILE_MAX_CHARS} characters. Cora reads these at the start of every turn in a chat that uses this profile.`}
        >
          <textarea
            className="spark-input"
            value={draft.instructions}
            maxLength={PROFILE_MAX_CHARS}
            rows={4}
            placeholder="e.g. Review every change for security and test coverage before saying it is done. Be brief."
            disabled={busy}
            onChange={(event) => onDraftChange({ ...draft, instructions: event.target.value })}
            style={{ ...textareaStyle, fontFamily: "var(--font-sans)" }}
          />
        </Field>
        <div>
          <button
            type="submit"
            className="spark-btn"
            disabled={busy || draft.name.trim().length === 0}
          >
            {operation === "creating" ? "Creating" : "Create profile"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ProfileRow({
  profile,
  busy,
  highlighted,
  editing,
  documentBusy,
  documentError,
  onMakeDefault,
  onDelete,
  onShowMemory,
  onEditDocument,
  onDocumentChange,
  onSaveDocument,
  onCancelDocument,
}: {
  profile: CoraProfile;
  busy: boolean;
  highlighted: boolean;
  editing: ProfileDocumentDraft | null;
  documentBusy: boolean;
  documentError: string | null;
  onMakeDefault: (profile: CoraProfile) => void;
  onDelete: (profile: CoraProfile) => void;
  onShowMemory: (profile: CoraProfile) => void;
  onEditDocument: (profile: CoraProfile) => void;
  onDocumentChange: (content: string) => void;
  onSaveDocument: () => void;
  onCancelDocument: () => void;
}) {
  const builtIn = profile.id === "default";
  const tooLong = (editing?.content.length ?? 0) > PROFILE_MAX_CHARS;
  return (
    <div
      className="agent-capability-row"
      style={{
        ...rowStyle,
        gridTemplateColumns: "minmax(0, 1fr) auto",
        boxShadow: highlighted ? "inset 2px 0 0 var(--accent)" : undefined,
        paddingLeft: highlighted ? 12 : undefined,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={rowNameStyle}>{profile.name}</span>
          {profile.isDefault ? (
            <span className="spark-badge is-accent" style={badgeStyle}>
              Default for new chats
            </span>
          ) : null}
          {builtIn ? (
            <span className="spark-badge" style={badgeStyle}>
              Built in
            </span>
          ) : null}
        </div>
        <div style={{ ...rowNoteStyle, marginTop: 3 }}>
          {profile.description || (builtIn ? "The standard Cora." : "No purpose written yet.")}
        </div>
      </div>
      <div style={rowActionsStyle}>
        <button
          type="button"
          className="spark-btn"
          style={smallBtnStyle}
          disabled={busy || documentBusy || editing !== null}
          onClick={() => onEditDocument(profile)}
          aria-label={`Edit the instructions of ${profile.name}`}
        >
          Edit instructions
        </button>
        <button
          type="button"
          className="spark-btn"
          style={smallBtnStyle}
          onClick={() => onShowMemory(profile)}
          aria-label={`Show the memory of ${profile.name}`}
        >
          Memory
        </button>
        {!profile.isDefault ? (
          <button
            type="button"
            className="spark-btn"
            style={smallBtnStyle}
            disabled={busy}
            onClick={() => onMakeDefault(profile)}
            title="New chats and automations use this profile unless you pick another"
          >
            Make default
          </button>
        ) : null}
        {!builtIn ? (
          <ConfirmRemoveButton
            busy={busy}
            disabled={false}
            label="Delete"
            ariaLabel={`Delete ${profile.name}`}
            title={`Delete ${profile.name} and move its identity and memories to Trash`}
            onConfirm={() => onDelete(profile)}
          />
        ) : null}
      </div>
      {editing ? (
        <div style={{ gridColumn: "1 / -1", display: "grid", gap: 8 }}>
          <Field
            label={`Instructions for ${profile.name} (PROFILE.md)`}
            hint={`${editing.content.length} / ${PROFILE_MAX_CHARS} characters. Markdown. Lines inside <!-- --> are notes Cora does not see.`}
          >
            <textarea
              className="spark-input"
              value={editing.content}
              rows={9}
              autoFocus
              disabled={documentBusy}
              placeholder={`# ${profile.name}\n\n## Instructions\n\nHow should this Cora work? What should it care about?`}
              onChange={(event) => onDocumentChange(event.target.value)}
              style={textareaStyle}
            />
          </Field>
          {documentError ? (
            <div role="alert" style={formErrorStyle}>
              {documentError}
            </div>
          ) : null}
          {tooLong ? (
            <div role="alert" style={formErrorStyle}>
              Instructions are limited to {PROFILE_MAX_CHARS} characters.
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="spark-btn is-primary"
              style={smallBtnStyle}
              disabled={documentBusy || tooLong || editing.content === editing.original}
              onClick={onSaveDocument}
            >
              {documentBusy ? "Saving" : "Save instructions"}
            </button>
            <button type="button" className="spark-btn" style={smallBtnStyle} disabled={documentBusy} onClick={onCancelDocument}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const formTitleStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: 1.35,
};
