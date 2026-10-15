import { useCallback, useEffect, useRef, useState } from "react";
import {
  SHARE_EXPIRY_CHOICES,
  formatShareBytes,
  type SharedPage,
  type SharedPagesList,
  type ShareExpiryDays,
} from "@shared/share";
import AnchoredMenu from "../chat/composer/AnchoredMenu";
import { SETTINGS_MENU_Z } from "../AccountCardPrimitives";
import { EmptyState, InlineMessage, SettingsSection } from "../settings/SettingsPrimitives";
import { shareErrorText } from "./errors";

// Settings, "Shared pages": every link this computer shared, with copy,
// expiry and delete. The service's list is the truth; when it cannot be
// reached the page shows this computer's copy and says so. The renderer only
// ever sees links and metadata, never the share key.

function formatDate(epochMs: number): string {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleDateString();
}

export default function SharedPagesSettings() {
  const [list, setList] = useState<SharedPagesList | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await window.spark.share.list());
    } catch (err) {
      setError(shareErrorText(err));
      setList((current) => current ?? { pages: [], offline: true });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(shareErrorText(err));
    } finally {
      setBusyId(null);
    }
  };

  const copy = (page: SharedPage) =>
    run(page.id, async () => {
      await window.spark.clipboard.writeText(page.url);
      setCopiedId(page.id);
      window.setTimeout(() => setCopiedId((current) => (current === page.id ? null : current)), 1500);
    });

  const extend = (page: SharedPage, days: ShareExpiryDays) =>
    run(page.id, async () => {
      const next = await window.spark.share.setExpiry(page.id, days);
      setList((current) =>
        current ? { ...current, pages: current.pages.map((entry) => (entry.id === next.id ? next : entry)) } : current,
      );
    });

  const remove = (page: SharedPage) =>
    run(page.id, async () => {
      await window.spark.share.delete(page.id);
      setConfirmId(null);
      setList((current) =>
        current ? { ...current, pages: current.pages.filter((entry) => entry.id !== page.id) } : current,
      );
    });

  return (
    <SettingsSection
      title="Shared pages"
      description="Pages you shared as a link from this computer. Anyone with a link can open its page until it expires or you delete it."
      plain
    >
      {list?.offline ? (
        <InlineMessage tone="warn" role="status">
          Could not reach the share service, so this is the list saved on this computer.
        </InlineMessage>
      ) : null}
      {error ? (
        <InlineMessage tone="danger" role="alert">
          {error}
        </InlineMessage>
      ) : null}
      {list === null ? null : list.pages.length === 0 ? (
        <EmptyState
          icon={<LinkIcon size={20} />}
          title="No shared pages."
          body="Open an HTML or Markdown file and choose Share as link in its toolbar."
        />
      ) : (
        <div className="st-list">
          {list.pages.map((page) => (
            <div key={page.id} className="st-list__row st-device" data-shared-page={page.id}>
              <span aria-hidden className="st-device__icon">
                <LinkIcon size={16} />
              </span>
              <div className="st-device__text">
                <div className="st-device__name" title={page.title}>
                  {page.title}
                </div>
                <div className="st-device__meta">
                  <span className="spark-mono">{page.url}</span>
                  {`, ${formatShareBytes(page.size)}, expires ${formatDate(page.expiresAt)}`}
                </div>
              </div>
              <button
                type="button"
                className="spark-btn"
                disabled={busyId === page.id}
                onClick={() => void copy(page)}
              >
                {copiedId === page.id ? "Copied" : "Copy link"}
              </button>
              {!list.offline ? (
                <ExpiryMenu disabled={busyId === page.id} onPick={(days) => void extend(page, days)} />
              ) : null}
              {confirmId === page.id ? (
                <button
                  type="button"
                  className="spark-btn is-danger"
                  disabled={busyId === page.id}
                  onClick={() => void remove(page)}
                  onBlur={() => setConfirmId((current) => (current === page.id ? null : current))}
                  autoFocus
                >
                  Delete link
                </button>
              ) : (
                <button
                  type="button"
                  className="spark-btn is-danger"
                  disabled={busyId === page.id}
                  onClick={() => setConfirmId(page.id)}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

function ExpiryMenu({ disabled, onPick }: { disabled: boolean; onPick: (days: ShareExpiryDays) => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="spark-btn"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Expiry
      </button>
      <AnchoredMenu
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        className="spark-menu"
        role="menu"
        ariaLabel="Link expires"
        placement="below"
        align="end"
        zIndex={SETTINGS_MENU_Z}
      >
        {SHARE_EXPIRY_CHOICES.map((days) => (
          <button
            key={days}
            type="button"
            role="option"
            className="spark-menu-item"
            onClick={() => {
              setOpen(false);
              onPick(days);
            }}
          >
            Expire {days} days from today
          </button>
        ))}
      </AnchoredMenu>
    </>
  );
}

function LinkIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
    </svg>
  );
}
