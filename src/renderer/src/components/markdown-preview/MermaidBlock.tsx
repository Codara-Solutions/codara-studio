import { useEffect, useRef, useState } from "react";
import { loadMermaid } from "./mermaid";

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
