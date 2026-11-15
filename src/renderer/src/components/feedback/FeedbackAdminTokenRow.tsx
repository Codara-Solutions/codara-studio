import React, { useEffect, useState } from "react";
import type { FeedbackAdminTokenState } from "@shared/feedback";
import { SettingRow } from "../settings/SettingsPrimitives";

// Settings, About, Feedback: the token that lets this Codara's agents read
// and manage feedback (codara_feedback_list, _update, _delete). Write-only:
// main keeps it encrypted and only ever tells the window whether one is set.

function stateText(state: FeedbackAdminTokenState | null): string {
  if (!state) return "";
  if (state.source === "env") return "Set by CODARA_FEEDBACK_ADMIN_TOKEN. Agents in your terminals can read and manage feedback.";
  if (state.source === "saved") return "Saved, encrypted with your system keyring. Agents in your terminals can read and manage feedback.";
  if (!state.canSave) return "This system has no keyring to encrypt a token. Set CODARA_FEEDBACK_ADMIN_TOKEN instead.";
  return "For Codara staff: lets your agents read and manage feedback. Deleting always asks you first.";
}

export default function FeedbackAdminTokenRow(): React.ReactElement {
  const [state, setState] = useState<FeedbackAdminTokenState | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.spark.feedback.adminTokenState().then(setState, () => undefined);
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.spark.feedback.saveAdminToken(draft);
      if (result.ok) {
        setState(result.state);
        setDraft("");
      } else {
        setError(result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      setState(await window.spark.feedback.removeAdminToken());
    } finally {
      setBusy(false);
    }
  };

  const env = state?.source === "env";
  return (
    <SettingRow
      title="Feedback admin token"
      htmlFor="settings-feedback-admin-token"
      desc={error ? <span role="alert" className="st-text-danger">{error}</span> : stateText(state)}
      stacked
    >
      <span className="st-input-group">
        <input
          id="settings-feedback-admin-token"
          className="spark-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          disabled={!state || env || !state.canSave || busy}
          placeholder={state?.source === "saved" ? "Saved" : "Paste a token"}
          onChange={(event) => {
            setError(null);
            setDraft(event.currentTarget.value);
          }}
        />
        <button type="button" className="spark-btn" disabled={busy || !draft.trim()} onClick={() => void save()}>
          Save
        </button>
        {state?.source === "saved" ? (
          <button type="button" className="spark-btn" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        ) : null}
      </span>
    </SettingRow>
  );
}
