import React from "react";
import type { AgentRuntimeCapability, AgentRuntimeDiagnostic } from "@shared/types";

interface Props {
  runtime: AgentRuntimeDiagnostic | null;
  feature: AgentRuntimeCapability;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

// Renders `children` only when the active runtime advertises `feature`. Keeps
// UI surfaces that depend on runtime-specific features (cost tracking, plan
// mode, shift+enter newline, ...) out of the tree for runtimes that don't
// support them. Pass `fallback` to render a placeholder instead.
export function Capability({
  runtime,
  feature,
  fallback = null,
  children,
}: Props): React.ReactElement | null {
  const supported = runtime?.capabilities?.[feature] === true;
  return <>{supported ? children : fallback}</>;
}
