import { useEffect, useMemo, useState } from "react";
import type { AgentRuntimeDiagnostic, ChatBackendKind } from "@shared/types";

// One pickable engine for the "Run plan" / "Smart Merge" pickers. `backend`
// is undefined for the default Codara engine (the OpenRouter manager) and the
// CLI runtime kind otherwise. A glyph keeps the rows recognizable at a glance,
// matching the composer's model picker vocabulary.
export interface EngineOption {
  key: "spark" | ChatBackendKind;
  backend?: ChatBackendKind;
  label: string;
  glyph: string;
}

// The built-in OpenRouter manager. Demoted to LAST and labeled "API": the CLI
// agents (Claude / Codex) are the primary engines; the API manager remains for
// users who explicitly want it (its key stays "spark" so existing callers and
// persisted picks keep working).
const SPARK_OPTION: EngineOption = { key: "spark", label: "API", glyph: "✦" };

function isAvailable(
  diagnostics: AgentRuntimeDiagnostic[],
  kind: "claude" | "codex",
): boolean {
  if (diagnostics.length === 0) return false;
  const entry = diagnostics.find((d) => d.kind === kind);
  if (!entry) return false;
  return entry.installed === true && entry.disabledBySettings !== true;
}

function labelFor(
  diagnostics: AgentRuntimeDiagnostic[],
  kind: "claude" | "codex",
  fallback: string,
): string {
  return diagnostics.find((d) => d.kind === kind)?.label ?? fallback;
}

// Build the visible engine list from runtime diagnostics. Claude / Codex lead
// when installed; the API manager is always last. A single-element result
// (just API — nothing installed) signals callers to render their plain
// single-action affordance with no engine submenu.
export function buildEngineOptions(diagnostics: AgentRuntimeDiagnostic[]): EngineOption[] {
  const options: EngineOption[] = [];
  if (isAvailable(diagnostics, "claude")) {
    options.push({
      key: "claude",
      backend: "claude",
      label: labelFor(diagnostics, "claude", "Claude Code"),
      glyph: "◇",
    });
  }
  if (isAvailable(diagnostics, "codex")) {
    options.push({
      key: "codex",
      backend: "codex",
      label: labelFor(diagnostics, "codex", "Codex"),
      glyph: "◆",
    });
  }
  options.push(SPARK_OPTION);
  return options;
}

// Fetch runtime diagnostics once on mount and derive the engine list. There's
// no runtimes-changed event to subscribe to, so a single fetch matches the
// composer's approach; agents.runtimes() is cached in the main process, so the
// duplicate fetch from FileTree + CommitComposer is cheap. Before the fetch
// resolves, only Codara shows (callers render their plain action), then the CLI
// engines fill in — which is fine since menus open well after app start.
export function useEngineOptions(): EngineOption[] {
  const [diagnostics, setDiagnostics] = useState<AgentRuntimeDiagnostic[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.spark.agents
      .runtimes()
      .then((result) => {
        if (!cancelled) setDiagnostics(result ?? []);
      })
      .catch(() => {
        if (!cancelled) setDiagnostics([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => buildEngineOptions(diagnostics), [diagnostics]);
}
