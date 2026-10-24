// Shared by the preview (MermaidBlock) and the Share packager, which renders
// diagrams to SVG for a shared page.
//
// Mermaid is ~600KB minified. We dynamic-import it on first render so opening
// an MD file without a mermaid fence costs nothing. A single module-level
// promise serializes initialization across blocks: every <MermaidBlock> reuses
// the same instance instead of racing to mermaid.initialize().
type MermaidModule = typeof import("mermaid");

let mermaidPromise: Promise<MermaidModule["default"]> | null = null;

export function loadMermaid(): Promise<MermaidModule["default"]> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        // `dark` theme matches the warm-tinted palette closely enough that we
        // don't need a custom theme block; the surrounding .spark-mermaid
        // container provides the background tint.
        theme: "dark",
        securityLevel: "strict",
        // The renderer measures fonts against document.body; bumping a few
        // defaults makes diagrams legible against the editor pane's scale.
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      });
      return m.default;
    });
  }
  return mermaidPromise;
}
