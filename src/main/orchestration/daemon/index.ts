// Scaffold boundary for the orchestration-core daemon split. This barrel is the
// single `orchestration/daemon` entry point consumed by the inert integration
// hook in index.ts today and by the renderer's DaemonClient in a later phase.
// Re-exporting every public symbol here keeps tsc/the bundler from tree-shaking
// the new (not-yet-consumed) modules away. See docs/daemon-split-PLAN.md.

// Types-only IPC seam: DaemonRequest/DaemonResponse unions, the
// SparkEvent-carrying DaemonEventFrame, and the loopback handshake constants.
export * from "./daemon-ipc";

// Headless host lifecycle, shaped after startAgentSocket/stopAgentSocket, plus
// the inert registerDaemonHostScaffold() integration shim and the runId-filtered
// event fan-out the host streams over /rpc.
export {
  startDaemonHostServer,
  stopDaemonHost,
  registerDaemonHostScaffold,
  subscribeDaemonEvents,
} from "./daemon-host";

// Thin out-of-process client stub (Bearer auth over loopback /rpc); not yet
// wired into the renderer.
export { DaemonClient } from "./daemon-client";
