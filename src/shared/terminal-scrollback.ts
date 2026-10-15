// The line main writes after a pane's restored output
// (src/main/terminal-scrollback-store.ts). The renderer reads it back to know
// where replayed history ends, also after a remount rebuilt the buffer from a
// text snapshot (src/renderer/src/components/Terminal/persistedScrollback.ts).
export const RESTORED_OUTPUT_MARKER_TEXT = "[Restored from before Codara restarted]";
