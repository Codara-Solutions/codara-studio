import { useEffect, useRef, useState } from "react";

// Mermaid is ~600KB minified. We dynamic-import it on first render so opening
// an MD file without a mermaid fence costs nothing. A single module-level
// promise serializes initialization across blocks: every <MermaidBlock> reuses
// the same instance instead of racing to mermaid.initialize().
type MermaidModule = typeof import("mermaid");

let mermaidPromise: Promise<MermaidModule["default"]> | null = null;

function loadMermaid(): Promise<MermaidModule["default"]> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        // `dark` theme matches the warm-tinted palette closely enough that we
        // don't need a custom theme block; the surrounding .spark-mermaid
        // container provides the background tint.
        theme: "dark",
        securityLevel: "strict",
        // The renderer measures fonts against document.body — bumping a few
        // defaults makes diagrams legible against the editor pane's scale.
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

// Stable id generator so re-renders don't collide with mermaid's internal
// SVG id namespace. Mermaid's render() returns innerHTML — the id is only used
// during parsing — so a counter is sufficient.
let nextId = 0;

export default function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `spark-mermaid-${++nextId}`;
    setError(null);
    void loadMermaid()
      .then(async (mermaid) => {
        try {
          // `parse` throws synchronously on invalid syntax; surface that as a
          // pre-formatted error block instead of the cryptic SVG mermaid emits.
          await mermaid.parse(code);
          const { svg } = await mermaid.render(id, code);
          if (cancelled) return;
          if (containerRef.current) {
            containerRef.current.innerHTML = svg;
          }
        } catch (e) {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(
          `Failed to load mermaid: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="spark-mermaid-error">
        Mermaid render failed: {error}
        {"\n\n"}
        {code}
      </div>
    );
  }
  return <div ref={containerRef} className="spark-mermaid" />;
}
