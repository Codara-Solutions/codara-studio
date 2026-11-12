import React, { useEffect, useState } from "react";
import type { DevUpdateHint } from "@shared/dev-update-hint";

// A dev build's quiet "Studio is N changes behind main · restart to update"
// in the status bar (src/main/dev-update-hint.ts). The tooltip has the exact
// command; nothing here pulls or restarts. Hidden when main has nothing to
// say, which is always in a packaged build.
export default function DevUpdateItem(): React.ReactElement | null {
  const [hint, setHint] = useState<DevUpdateHint | null>(null);
  useEffect(() => {
    const api = window.spark?.devUpdate;
    if (!api) return;
    let alive = true;
    const read = () => {
      void api.status().then(
        (next) => alive && setHint(next),
        () => undefined,
      );
    };
    read();
    const off = api.onChanged((next) => alive && setHint(next));
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      off();
      window.removeEventListener("focus", read);
    };
  }, []);
  if (!hint) return null;
  return (
    <div
      data-testid="dev-update-hint"
      data-kind={hint.kind}
      title={hint.detail}
      aria-label={`${hint.text}. ${hint.detail}`}
      style={{
        padding: "0 14px",
        display: "flex",
        alignItems: "center",
        borderLeft: "1px solid var(--rule-soft)",
        minWidth: 0,
        cursor: "default",
      }}
    >
      <span
        style={{
          color: "var(--ink-dim)",
          fontSize: 10,
          fontWeight: 500,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: 360,
        }}
      >
        {hint.text}
      </span>
    </div>
  );
}
