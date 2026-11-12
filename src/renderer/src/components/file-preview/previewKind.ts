// The table lives in @shared so main's open checks (Quick Open, the
// desktop command, codara_open_file) read the same one as the editor tabs.
export { previewKindForPath, type PreviewKind } from "@shared/preview-kind";
