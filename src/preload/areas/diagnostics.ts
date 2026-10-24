// window.spark.diagnostics: the renderer side of src/main/diagnostics/ (the
// crash and freeze black box on Settings > About).

import { ipcRenderer } from "electron";

import type { DiagnosticsExportResult, DiagnosticsSummary } from "@shared/diagnostics";

export const diagnosticsApi = {
  summary: (): Promise<DiagnosticsSummary> => ipcRenderer.invoke("diagnostics:summary"),
  /** Asks where to save, then writes the redacted zip there. */
  exportBundle: (): Promise<DiagnosticsExportResult> => ipcRenderer.invoke("diagnostics:export"),
  /** Shows the last exported zip in the system file manager. */
  revealExport: (): Promise<boolean> => ipcRenderer.invoke("diagnostics:reveal"),
};
