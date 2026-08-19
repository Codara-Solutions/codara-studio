import { useEffect, useRef, useState } from "react";
import type { CoraProfile } from "@shared/types";
import AnchoredMenu from "./AnchoredMenu";

interface Props {
  profiles: CoraProfile[];
  activeProfileId: string;
  onPick: (profileId: string) => void;
  onManage: () => void;
}

// Draft-only identity selector. A run freezes its profile when it is created,
// so this intentionally disappears after the first message rather than
// offering a switch that cannot affect the active conversation.
export default function ProfilePicker({
  profiles,
  activeProfileId,
  onPick,
  onManage,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const active = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];

  useEffect(() => {
    if (profiles.some((profile) => profile.id === activeProfileId)) return;
    const fallback = profiles.find((profile) => profile.isDefault) ?? profiles[0];
    if (fallback) onPick(fallback.id);
  }, [activeProfileId, onPick, profiles]);

  if (!active || profiles.length < 2) return null;

  return (
    <div className="composer-profile">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-pill composer-profile-trigger${open ? " is-active" : ""}`}
        title={`Cora profile: ${active.name}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="composer-profile-glyph" aria-hidden>✦</span>
        <span className="composer-profile-label">{active.name}</span>
        <span aria-hidden className="composer-chevron">⌄</span>
      </button>
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        className="composer-profile-menu spark-menu"
        role="listbox"
        ariaLabel="Cora profile for this new chat"
      >
        <div className="composer-menu-heading">Cora for this chat</div>
        {profiles.map((profile) => {
          const selected = profile.id === active.id;
          return (
            <button
              key={profile.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={`composer-profile-option${selected ? " is-active" : ""}`}
              onClick={() => {
                onPick(profile.id);
                setOpen(false);
              }}
            >
              <span className="composer-profile-mark" aria-hidden>{selected ? "✦" : "·"}</span>
              <span className="composer-profile-copy">
                <span>{profile.name}</span>
                <small>{profile.description || (profile.isDefault ? "Default for new chats" : "Isolated memory")}</small>
              </span>
            </button>
          );
        })}
        <button
          type="button"
          className="composer-profile-manage"
          onClick={() => {
            setOpen(false);
            onManage();
          }}
        >
          Manage profiles…
        </button>
      </AnchoredMenu>
    </div>
  );
}
