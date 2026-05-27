import { useEffect, useRef, useState } from "react";
import type { ChatBackendKind } from "@shared/types";
import {
  CHAT_BACKEND_GROUPS,
  type ChatModelOption,
} from "./types";

interface Props {
  activeBackend: ChatBackendKind;
  activeModelId: string;
  onPick: (model: ChatModelOption) => void;
}

// The model pill + grouped dropdown menu. Pure presentation: the parent
// (ChatComposer) owns model/backend state; this picker just renders the
// pill and fires onPick when the user chooses a different model.
export default function ModelPicker({ activeBackend, activeModelId, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeLabel = activeModelLabel(activeBackend, activeModelId);

  const select = (model: ChatModelOption) => {
    onPick(model);
    setOpen(false);
  };

  return (
    <div className="composer-model" ref={rootRef}>
      <button
        type="button"
        className="composer-pill"
        onClick={() => setOpen((value) => !value)}
        title="Chat model"
      >
        <span aria-hidden style={{ marginRight: 4 }}>☀</span>
        {activeLabel}
      </button>
      {open && (
        <div className="composer-model-menu" role="listbox">
          {CHAT_BACKEND_GROUPS.map((group) => (
            <div key={group.backend} className="composer-model-group">
              <div className="composer-model-group-label">{group.label}</div>
              {group.models.map((model) => {
                const active =
                  model.id === activeModelId && model.backend === activeBackend;
                return (
                  <button
                    key={`${model.backend}:${model.id}`}
                    type="button"
                    className={`composer-model-row${active ? " is-active" : ""}`}
                    onClick={() => select(model)}
                  >
                    <span className="composer-model-row-label">{model.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function activeModelLabel(backend: ChatBackendKind, modelId: string): string {
  for (const group of CHAT_BACKEND_GROUPS) {
    if (group.backend !== backend) continue;
    const hit = group.models.find((model) => model.id === modelId);
    if (hit) return hit.label;
  }
  return modelId || "Pick a model";
}
