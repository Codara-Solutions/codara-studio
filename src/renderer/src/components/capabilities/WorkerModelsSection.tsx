import React, { useEffect, useState } from "react";
import { CODEX_MODEL_CATALOG } from "@shared/model-catalog";
import { AGENT_FAMILIES, familyForModelId } from "@shared/agent-families";
import {
  WORKER_MODEL_ROSTER,
  isOpenRouterModelId,
  workerModelSubscription,
} from "@shared/worker-model-roster";
import {
  SwitchTrack,
  WarnGlyph,
  noticeStyle,
  sectionStyle,
  toggleListStyle,
  toggleRowStyle,
  useInteractive,
  withFocusRing,
} from "./controls";

export default function WorkerModelsSection({
  choices,
  enabled,
  usable,
  openRouterVerified,
  onToggle,
}: {
  choices: string[];
  enabled: string[];
  usable: string[];
  openRouterVerified: boolean | null;
  onToggle: (modelId: string) => void;
}) {
  const groups = groupWorkerModels(choices);
  const usableSet = new Set(usable);
  // Cora is offered only models whose provider has a usable account, so a row
  // for a signed-out provider says why it will not be used.
  const [usableSubscriptions, setUsableSubscriptions] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.spark.piSubscriptions
      .status()
      .then((overview) => {
        if (cancelled) return;
        setUsableSubscriptions(new Set(
          (overview.profiles ?? [])
            .filter((profile) => profile.connected && (!profile.expired || profile.canRefresh))
            .map((profile) => profile.provider),
        ));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const signedOutModel = (modelId: string): boolean => {
    const subscription = workerModelSubscription(modelId);
    return Boolean(usableSubscriptions && subscription && !usableSubscriptions.has(subscription));
  };
  // Switched on is not the same as runnable: with every switched-on model's
  // provider signed out, Cora has no worker to start.
  const runnable = enabled.filter((modelId) => usableSet.has(modelId));
  const noneSignedIn =
    usableSubscriptions !== null && runnable.length > 0 && runnable.every(signedOutModel);
  return (
    <section style={sectionStyle}>
      {usable.length === 0 ? (
        <div style={noticeStyle} role="alert">
          <WarnGlyph />
          <span>
            No worker model is usable, so Cora cannot start workers. Switch on at least one Claude, Codex or
            Grok model{openRouterVerified === false ? ", or verify your OpenRouter key in Settings, API and model" : ""}.
          </span>
        </div>
      ) : noneSignedIn ? (
        <div style={noticeStyle} role="alert">
          <WarnGlyph />
          <span>
            None of the switched-on models has a signed-in account, so Cora cannot start workers yet.{" "}
            <button
              type="button"
              className="spark-btn"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("spark:open-settings", { detail: { section: "agents" } }))
              }
            >
              Open Accounts
            </button>
          </span>
        </div>
      ) : null}
      <div role="group" aria-label="Cora worker models" style={toggleListStyle}>
        {groups.map((group) => (
          <div key={group.label} role="group" aria-label={`${group.label} worker models`}>
            <div style={groupLabelStyle}>{group.label}</div>
            <div className="st-rows">
              {group.models.map((modelId) => {
                const on = enabled.includes(modelId);
                const unusable = on && !usableSet.has(modelId)
                  ? isOpenRouterModelId(modelId)
                    ? "Not usable: the OpenRouter key is not verified, or this model is no longer a Cora favorite in Settings, API and model."
                    : "Not usable right now."
                  : null;
                const signedOut = signedOutModel(modelId);
                return (
                  <WorkerModelRow
                    key={modelId}
                    modelId={modelId}
                    checked={on}
                    unusable={unusable}
                    signedOut={signedOut}
                    onToggle={() => onToggle(modelId)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// The list divides by model source, not one flat roster: the three native
// families under the names the rest of the app uses (Claude, Codex, Grok),
// then the user's OpenRouter favorites. "Other" only exists so an id with an
// unrecognized shape stays visible and toggleable instead of vanishing.
const WORKER_MODEL_GROUP_ORDER = ["Claude", "Codex", "Grok", "OpenRouter", "Other"] as const;

function workerModelGroupFor(modelId: string): string {
  // OpenRouter ids are vendor/model paths; native Pi ids never contain "/".
  if (modelId.includes("/")) return "OpenRouter";
  const family = familyForModelId(modelId);
  return family ? AGENT_FAMILIES[family].displayName : "Other";
}

function groupWorkerModels(choices: string[]): { label: string; models: string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const modelId of choices) {
    const group = workerModelGroupFor(modelId);
    const bucket = buckets.get(group);
    if (bucket) bucket.push(modelId);
    else buckets.set(group, [modelId]);
  }
  return WORKER_MODEL_GROUP_ORDER.filter((label) => buckets.has(label)).map((label) => ({
    label,
    models: buckets.get(label)!,
  }));
}

// Presentation is derived from the id alone: a friendly label for scanning
// and a premium flag for the one roster entry that is materially more
// expensive. Attribution comes from the group heading the row renders under.
// The EXACT id always renders beside the label in mono: the id, not the
// label, is what the spawn path enforces.
function workerModelPresentation(modelId: string): { label: string; premium: boolean } {
  const isOpenRouter = modelId.includes("/");
  const codexEntry = CODEX_MODEL_CATALOG.find((entry) => entry.id === modelId);
  const slug = (isOpenRouter ? modelId.split("/").at(-1) : modelId) ?? modelId;
  const label =
    codexEntry?.label ??
    slug
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) =>
        part.toLowerCase() === "gpt" ? "GPT" : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
      )
      .join(" ");
  return { label, premium: modelId === WORKER_MODEL_ROSTER.claude.premium };
}

// One compact de-boxed row per model: the whole row is the switch, and the
// group heading above carries the provider attribution.
function WorkerModelRow({
  modelId,
  checked,
  unusable,
  signedOut,
  onToggle,
}: {
  modelId: string;
  checked: boolean;
  unusable: string | null;
  signedOut: boolean;
  onToggle: () => void;
}) {
  const { focus, handlers } = useInteractive();
  const model = workerModelPresentation(modelId);
  // Switched on but out of reach: the row says why in plain text and the
  // switch dims, so "on" never reads as "running".
  const idle = checked && (signedOut || unusable !== null);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${model.label} (${modelId})`}
      aria-description={unusable ?? undefined}
      title={unusable ?? modelId}
      onClick={onToggle}
      {...handlers}
      style={{
        ...toggleRowStyle,
        padding: "11px 0",
        boxShadow: withFocusRing(undefined, focus),
      }}
    >
      <span style={nameCellStyle}>
        <span
          style={{
            ...labelStyle,
            // Only "on but out of reach" dims. An off row keeps full
            // contrast, as Settings rows do, so the two states never look
            // alike; the switch says which rows are off.
            color: idle ? "var(--st-desc)" : "var(--ink)",
          }}
        >
          {model.label}
        </span>
        {model.premium ? (
          <span className="spark-badge" style={tierStyle}>
            Premium
          </span>
        ) : null}
        {unusable ? (
          <span style={stateNoteStyle}>Not usable right now</span>
        ) : signedOut ? (
          <span
            style={stateNoteStyle}
            title="No account for this provider is signed in, so Cora will not use this model. Sign in under Settings, Accounts."
          >
            Not signed in, so Cora skips it
          </span>
        ) : null}
      </span>
      <SwitchTrack checked={checked} disabled={idle} />
    </button>
  );
}

// The source heading over each cluster: Claude, Codex, Grok, OpenRouter.
// Drawn like a Settings section title.
const groupLabelStyle: React.CSSProperties = {
  padding: "18px 0 10px",
  color: "var(--ink)",
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: 1.35,
};

const nameCellStyle: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "baseline",
  flexWrap: "wrap",
  columnGap: 8,
  rowGap: 2,
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  transition: "color var(--motion-fast) var(--ease-out)",
};

// The exact model id, always visible: it is the value that persists and that
// run-store enforces at spawn, so it must be copy-checkable at a glance.
const stateNoteStyle: React.CSSProperties = {
  flex: "0 0 auto",
  color: "var(--st-faint)",
  fontSize: 12,
};

const tierStyle: React.CSSProperties = {
  alignSelf: "center",
  flex: "0 0 auto",
};
