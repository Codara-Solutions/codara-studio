import React, { useEffect, useState } from "react";
import { CODEX_MODEL_CATALOG } from "@shared/model-catalog";
import { AGENT_FAMILIES, familyForModelId } from "@shared/agent-families";
import {
  WORKER_MODEL_ROSTER,
  isOpenRouterModelId,
  workerModelSubscription,
} from "@shared/worker-model-roster";
import {
  SectionHead,
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
  return (
    <section style={sectionStyle}>
      <SectionHead
        title="Worker models"
        detail={
          <>
            The models Cora may hand implementation and verification work to. Cora picks among the ones
            switched on. A change applies to the next worker that starts; running workers keep their model.
          </>
        }
      />
      {usable.length === 0 ? (
        <div style={noticeStyle} role="alert">
          <WarnGlyph />
          <span>
            No worker model is usable, so Cora cannot start workers. Switch on at least one Claude, Codex or
            Grok model{openRouterVerified === false ? ", or verify your OpenRouter key in Settings, API and model" : ""}.
          </span>
        </div>
      ) : null}
      <div role="group" aria-label="Cora worker models" style={toggleListStyle}>
        {groups.map((group) => (
          <div key={group.label} role="group" aria-label={`${group.label} worker models`}>
            <div style={groupLabelStyle}>{group.label}</div>
            {group.models.map((modelId) => {
              const on = enabled.includes(modelId);
              const unusable = on && !usableSet.has(modelId)
                ? isOpenRouterModelId(modelId)
                  ? "Not usable: the OpenRouter key is not verified, or this model is no longer a Cora favorite in Settings, API and model."
                  : "Not usable right now."
                : null;
              const subscription = workerModelSubscription(modelId);
              const signedOut = Boolean(
                usableSubscriptions && subscription && !usableSubscriptions.has(subscription),
              );
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
  const { hover, focus, pressed, handlers } = useInteractive();
  const model = workerModelPresentation(modelId);
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
        padding: "8px 8px",
        background: pressed ? "var(--press)" : hover ? "var(--hover)" : "transparent",
        boxShadow: withFocusRing(undefined, focus),
      }}
    >
      <span style={nameCellStyle}>
        <span
          style={{
            ...labelStyle,
            // Off rows dim their label so the enabled set pops at a glance;
            // the switch remains the authoritative state indicator.
            color: checked && !unusable ? "var(--ink)" : "var(--muted)",
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
          <span className="spark-badge is-warn" style={tierStyle}>
            Not usable
          </span>
        ) : null}
        {signedOut ? (
          <span
            className="spark-badge is-warn"
            style={tierStyle}
            title="No account for this provider is signed in, so Cora will not use this model. Sign in under Settings > Agents."
          >
            Not signed in
          </span>
        ) : null}
        <span style={idStyle}>{modelId}</span>
      </span>
      <SwitchTrack checked={checked} />
    </button>
  );
}

// The source heading over each cluster: Claude, Codex, Grok, OpenRouter.
const groupLabelStyle: React.CSSProperties = {
  padding: "12px 8px 3px",
  fontSize: 10,
  fontWeight: 650,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--muted-2)",
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
  fontWeight: 600,
  transition: "color var(--motion-fast) var(--ease-out)",
};

// The exact model id, always visible: it is the value that persists and that
// run-store enforces at spawn, so it must be copy-checkable at a glance.
const idStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  color: "var(--muted-2)",
};

const tierStyle: React.CSSProperties = {
  alignSelf: "center",
  flex: "0 0 auto",
  padding: "1px 5px",
  fontSize: 8.5,
  fontWeight: 650,
  letterSpacing: "0.04em",
};
