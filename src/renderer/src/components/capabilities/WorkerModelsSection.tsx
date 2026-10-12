import React, { useMemo } from "react";
import { CODEX_MODEL_CATALOG } from "@shared/model-catalog";
import { AGENT_FAMILIES, familyForModelId } from "@shared/agent-families";
import type { PiSubscriptionProvider, WorkerCatalogModel, WorkerModelCatalog, WorkerModelProviderState } from "@shared/types";
import { WORKER_MODEL_ROSTER, isOpenRouterModelId } from "@shared/worker-model-roster";
import {
  SearchField,
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

// Every model the signed-in providers offer, as the main process discovered
// them (worker-model-catalog.ts): the provider's own list where it can be
// read, the CLIs' caches, and Pi's catalog. A model found for the first time
// arrives switched off with a New badge; nothing here enables it.
export default function WorkerModelsSection({
  catalog,
  loading,
  refreshing,
  loadError,
  onRefresh,
  choices,
  enabled,
  usable,
  openRouterVerified,
  search,
  onSearch,
  onToggle,
}: {
  catalog: WorkerModelCatalog | null;
  loading: boolean;
  refreshing: boolean;
  loadError: string | null;
  onRefresh: () => void;
  choices: string[];
  enabled: string[];
  usable: string[];
  openRouterVerified: boolean | null;
  search: string;
  onSearch: (next: string) => void;
  onToggle: (modelId: string) => void;
}) {
  const byId = useMemo(() => new Map((catalog?.models ?? []).map((model) => [model.id, model])), [catalog]);
  const usableSet = new Set(usable);
  const query = search.trim().toLowerCase();
  const groups = groupWorkerModels(choices, byId).map((group) => ({
    ...group,
    models: query
      ? group.models.filter((modelId) => {
          const label = presentation(modelId, byId.get(modelId)).label;
          return `${label} ${modelId}`.toLowerCase().includes(query);
        })
      : group.models,
  }));
  const shown = groups.reduce((total, group) => total + group.models.length, 0);
  // Switched on is not the same as runnable: with every switched-on model's
  // provider signed out, Cora has no worker to start.
  const signedOutModel = (modelId: string) => byId.get(modelId)?.unavailable === "Not signed in";
  const runnable = enabled.filter((modelId) => usableSet.has(modelId));
  const noneSignedIn = catalog !== null && runnable.length > 0 && runnable.every(signedOutModel);
  const newCount = (catalog?.models ?? []).filter((model) => model.isNew).length;
  return (
    <section style={sectionStyle}>
      <SectionHead
        lead={<SearchField value={search} onChange={onSearch} placeholder="Filter models" />}
        actions={
          <>
            <span style={updatedStyle} aria-live="polite">
              {refreshing
                ? "Checking the providers..."
                : catalog?.refreshedAt
                  ? `Updated ${relativeTime(catalog.refreshedAt)}${newCount > 0 ? `, ${newCount} new` : ""}`
                  : null}
            </span>
            <button
              type="button"
              className="spark-btn"
              onClick={onRefresh}
              disabled={refreshing}
              title="Ask each signed-in provider for its current model list"
            >
              Refresh
            </button>
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
      {loadError ? (
        <div style={noticeStyle} role="alert">
          <WarnGlyph />
          <span>Could not read the model lists: {loadError}. Showing the models Codara ships with.</span>
        </div>
      ) : null}
      <div role="group" aria-label="Cora worker models" aria-busy={loading} style={toggleListStyle}>
        {groups.map((group) =>
          group.models.length === 0 ? null : (
            <div key={group.label} role="group" aria-label={`${group.label} worker models`}>
              <div style={groupHeadStyle}>
                <span style={groupLabelStyle}>{group.label}</span>
                {group.provider ? (
                  <ProviderNote state={catalog?.providers.find((entry) => entry.provider === group.provider)} />
                ) : null}
              </div>
              <div className="st-rows">
                {group.models.map((modelId) => {
                  const entry = byId.get(modelId);
                  const on = enabled.includes(modelId);
                  const reason = isOpenRouterModelId(modelId)
                    ? on && !usableSet.has(modelId)
                      ? "Key not verified"
                      : null
                    : entry?.unavailable ?? null;
                  return (
                    <WorkerModelRow
                      key={modelId}
                      modelId={modelId}
                      model={entry}
                      checked={on}
                      reason={reason}
                      onToggle={() => onToggle(modelId)}
                    />
                  );
                })}
              </div>
            </div>
          ),
        )}
        {shown === 0 && query ? <div style={emptyStyle}>No model matches this filter.</div> : null}
      </div>
    </section>
  );
}

const PROVIDER_SOURCE: Record<WorkerModelProviderState["listedFrom"], string> = {
  provider: "Listed by the provider for your account",
  cli: "From the CLI's own model list",
  pi: "From Pi's model catalog",
};

function ProviderNote({ state }: { state: WorkerModelProviderState | undefined }) {
  if (!state) return null;
  if (!state.signedIn) return <span style={groupNoteStyle}>Not signed in</span>;
  return (
    <span style={groupNoteStyle} title={state.note ?? undefined}>
      {PROVIDER_SOURCE[state.listedFrom]}
      {state.note ? `. ${state.note}` : ""}
    </span>
  );
}

// The list divides by provider, then the user's OpenRouter favorites. "Other"
// only exists so an id with an unrecognized shape stays visible and
// toggleable instead of vanishing.
const PROVIDER_GROUPS: Array<{ label: string; provider: PiSubscriptionProvider | null }> = [
  { label: AGENT_FAMILIES.claude.displayName, provider: "anthropic" },
  { label: AGENT_FAMILIES.codex.displayName, provider: "openai-codex" },
  { label: AGENT_FAMILIES.grok.displayName, provider: "xai" },
  { label: "OpenRouter", provider: null },
  { label: "Other", provider: null },
];

function workerModelGroupFor(modelId: string, model: WorkerCatalogModel | undefined): string {
  // OpenRouter ids are vendor/model paths; native Pi ids never contain "/".
  if (modelId.includes("/")) return "OpenRouter";
  if (model) return PROVIDER_GROUPS.find((group) => group.provider === model.provider)?.label ?? "Other";
  const family = familyForModelId(modelId);
  return family ? AGENT_FAMILIES[family].displayName : "Other";
}

function groupWorkerModels(
  choices: string[],
  byId: ReadonlyMap<string, WorkerCatalogModel>,
): Array<{ label: string; provider: PiSubscriptionProvider | null; models: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const modelId of choices) {
    const group = workerModelGroupFor(modelId, byId.get(modelId));
    const bucket = buckets.get(group);
    if (bucket) bucket.push(modelId);
    else buckets.set(group, [modelId]);
  }
  return PROVIDER_GROUPS.filter((group) => buckets.has(group.label)).map((group) => ({
    ...group,
    models: buckets.get(group.label)!,
  }));
}

// The catalog's label when the main process has one (curated, vendor, Pi);
// otherwise one derived from the id, so a model the catalog does not know
// still reads well. The exact id renders beside it in mono: the id, not the
// label, is what the spawn path enforces.
function presentation(modelId: string, model: WorkerCatalogModel | undefined): { label: string; premium: boolean } {
  if (model) return { label: model.label, premium: model.premium };
  const isOpenRouter = modelId.includes("/");
  const codexEntry = CODEX_MODEL_CATALOG.find((entry) => entry.id === modelId);
  const slug = (isOpenRouter ? modelId.split("/").at(-1) : modelId) ?? modelId;
  const label =
    codexEntry?.label ??
    slug
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => (part.toLowerCase() === "gpt" ? "GPT" : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
      .join(" ");
  return { label, premium: modelId === WORKER_MODEL_ROSTER.claude.premium };
}

const REASON_DETAIL: Record<string, string> = {
  "Not signed in": "No account for this provider is signed in, so Cora will not use this model. Sign in under Settings, Accounts.",
  "Not in your account's list": "The provider's model list for your account does not include it, so a launch would likely be refused.",
  "No longer listed": "No provider list or catalog mentions this model any more. Switch it off unless you know it still works.",
  "Key not verified": "The OpenRouter key is not verified, or this model is no longer a Cora favorite in Settings, API and model.",
};

// One compact de-boxed row per model: the whole row is the switch, and the
// group heading above carries the provider attribution.
function WorkerModelRow({
  modelId,
  model,
  checked,
  reason,
  onToggle,
}: {
  modelId: string;
  model: WorkerCatalogModel | undefined;
  checked: boolean;
  reason: string | null;
  onToggle: () => void;
}) {
  const { focus, handlers } = useInteractive();
  const shown = presentation(modelId, model);
  // Switched on but out of reach: the row says why in plain text and the
  // switch dims, so "on" never reads as "running".
  const idle = checked && reason !== null;
  const detail = reason ? REASON_DETAIL[reason] ?? reason : undefined;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${shown.label} (${modelId})`}
      aria-description={detail}
      title={detail ?? modelId}
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
          {shown.label}
        </span>
        {shown.premium ? (
          <span className="spark-badge" style={tierStyle}>
            Premium
          </span>
        ) : null}
        {model?.isNew ? (
          <span className="spark-badge" style={tierStyle} title={`First seen ${new Date(model.firstSeenAt).toLocaleDateString()}`}>
            New
          </span>
        ) : null}
        {shown.label !== modelId ? <span style={idStyle}>{modelId}</span> : null}
        {reason ? <span style={stateNoteStyle}>{reason}</span> : null}
      </span>
      <SwitchTrack checked={checked} disabled={idle} />
    </button>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const groupHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  flexWrap: "wrap",
  columnGap: 10,
  rowGap: 2,
  padding: "18px 0 10px",
};

// The provider heading over each cluster, drawn like a Settings section title.
const groupLabelStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: 1.35,
};

const groupNoteStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 12,
  minWidth: 0,
};

const updatedStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 12.5,
  fontVariantNumeric: "tabular-nums",
};

const emptyStyle: React.CSSProperties = {
  padding: "18px 0",
  color: "var(--st-faint)",
  fontSize: 12.5,
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

const idStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
};

const stateNoteStyle: React.CSSProperties = {
  flex: "0 0 auto",
  color: "var(--st-faint)",
  fontSize: 12,
};

const tierStyle: React.CSSProperties = {
  alignSelf: "center",
  flex: "0 0 auto",
};
