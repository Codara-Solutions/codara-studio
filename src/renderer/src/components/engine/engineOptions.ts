import type { ChatBackendKind } from "@shared/types";

// One pickable engine for the "Run plan" / "Smart Merge" pickers. Pi is the
// only Cora engine since the native Claude Code / Codex manager backends were
// retired; the option shape survives so the pickers (which already collapse a
// single-entry list to one direct button) don't need to know that.
export interface EngineOption {
  key: ChatBackendKind;
  backend: ChatBackendKind;
  label: string;
  glyph: string;
}

const PI_OPTION: EngineOption = { key: "pi", backend: "pi", label: "Cora · Pi", glyph: "✦" };

const OPTIONS: EngineOption[] = [PI_OPTION];

export function useEngineOptions(): EngineOption[] {
  return OPTIONS;
}
