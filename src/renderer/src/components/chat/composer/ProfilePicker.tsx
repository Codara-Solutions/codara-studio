import { useEffect, useRef, useState } from "react";
import type { CoraProfile } from "@shared/types";
import AnchoredMenu from "./AnchoredMenu";

interface Props {
  profiles: CoraProfile[];
  activeProfileId: string;
  onPick: (profileId: string) => void;
  onManage: () => void;
  /** A started chat froze its profile when it was created: show which one,
   *  but offer no switch that could not affect the conversation. */
  locked?: boolean;
}

// The Cora profile of this chat. A new chat picks it from the menu, which is
// shown even while only the built-in profile exists so "New profile" is
// discoverable. A started chat shows its profile as a read-only chip.
export default function ProfilePicker({
  profiles,
  activeProfileId,
  onPick,
  onManage,
  locked = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const active = profiles.find((profile) => profile.id === activeProfileId) ?? (locked ? undefined : profiles[0]);

  useEffect(() => {
    // Repairing a stale id only applies to a draft; a started chat's profile is
    // whatever the run recorded, even if that profile was deleted since.
    if (locked) return;
    if (profiles.some((profile) => profile.id === activeProfileId)) return;
    const fallback = profiles.find((profile) => profile.isDefault) ?? profiles[0];
    if (fallback) onPick(fallback.id);
  }, [activeProfileId, locked, onPick, profiles]);

  if (locked) {
    // A deleted profile's chats were moved to the built-in one, which is
    // named Cora; an id the list no longer has reads the same way.
    // No menu: it opens that profile in the Capability Center, where its
    // instructions and memory live.
    const name = active?.name ?? "Cora";
    return (
      <div className="composer-profile">
        <button
          type="button"
          className="composer-pill composer-profile-trigger is-locked"
          title={`Cora profile: ${name}. Profile is fixed for this chat. Open its instructions and memory.`}
          aria-label={`Cora profile: ${name}. Profile is fixed for this chat.`}
          onClick={onManage}
        >
          <span className="composer-profile-glyph" aria-hidden>✦</span>
          <span className="composer-profile-label">{name}</span>
        </button>
      </div>
    );
  }

  if (!active) return null;

  return (
    <div className="composer-profile">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-pill composer-profile-trigger${open ? " is-active" : ""}`}
        title={`Cora profile: ${active.name}`}
        aria-label={`Cora profile: ${active.name}`}
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
          {profiles.length < 2 ? "New profile…" : "New or edit profiles…"}
        </button>
      </AnchoredMenu>
    </div>
  );
}
