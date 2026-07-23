import { useEffect, useRef, useState } from "react";
import type { CoraExecutionPolicy } from "@shared/types";
import {
  CORA_EXECUTION_POLICIES,
  coraExecutionPolicyProfile,
} from "@shared/cora-execution-policy";

interface Props {
  value: CoraExecutionPolicy;
  onPick: (policy: CoraExecutionPolicy) => void;
}

export default function ExecutionPolicyPicker({ value, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = coraExecutionPolicyProfile(value);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="composer-model" ref={rootRef}>
      <button
        type="button"
        className={`composer-pill composer-policy-pill is-${active.id}${open ? " is-active" : ""}`}
        onClick={() => setOpen((current) => !current)}
        title={`Pi execution policy · ${active.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <PolicyGlyph policy={active.id} />
        {active.shortLabel}
      </button>
      {open ? (
        <div className="composer-model-menu composer-policy-menu spark-menu" role="listbox">
          <div className="composer-model-group-label">Pi execution policy</div>
          {CORA_EXECUTION_POLICIES.map((profile) => (
            <button
              key={profile.id}
              type="button"
              role="option"
              aria-selected={profile.id === value}
              className={`composer-model-row${profile.id === value ? " is-active" : ""}`}
              onClick={() => {
                onPick(profile.id);
                setOpen(false);
              }}
            >
              <span className="composer-model-row-copy">
                <span className="composer-model-row-label">{profile.label}</span>
                <span className="composer-model-row-description">{profile.description}</span>
              </span>
              <span className="composer-model-row-badges">
                <span className={`composer-badge is-policy-${profile.id}`}>{profile.badge}</span>
              </span>
            </button>
          ))}
          <div className="composer-policy-footnote">
            Policy is stored with this chat. Frontier may reuse analysis only for an exact tracked state;
            all patch verification remains fresh.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PolicyGlyph({ policy }: { policy: CoraExecutionPolicy }) {
  const rings = policy === "frontier" ? 3 : policy === "deep" ? 2 : 1;
  return (
    <span className="composer-policy-glyph" aria-hidden>
      {Array.from({ length: rings }, (_, index) => (
        <span key={index} />
      ))}
    </span>
  );
}
