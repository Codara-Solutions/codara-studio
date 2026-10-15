import { useEffect, useMemo, useRef, useState } from "react";
import AnchoredMenu from "../chat/composer/AnchoredMenu";
import {
  SHARE_DEFAULT_EXPIRY_DAYS,
  SHARE_EXPIRY_CHOICES,
  SHARE_MAX_PAGE_BYTES,
  formatShareBytes,
  type SharedPage,
  type ShareExpiryDays,
} from "@shared/share";
import { appPackageDeps, packageForShare, type PackagedShare } from "./package";
import { shareWorkspaceRoots } from "./offer-store";
import { shareErrorText } from "./errors";
import "./share.css";

// The Share prompt. It packages the page on this computer and shows what
// would be shared; the upload starts only on the Share button. Loaded on
// first use so the packager (parse5, the static renderer) stays off the
// editor's eager path.

type Stage =
  | { kind: "preparing" }
  | { kind: "ready"; page: PackagedShare }
  | { kind: "uploading"; page: PackagedShare }
  | { kind: "done"; page: PackagedShare; shared: SharedPage; copied: boolean }
  | { kind: "failed"; message: string; page: PackagedShare | null };

const LEFT_OUT_REASON: Record<string, string> = {
  outside: "outside this folder",
  hidden: "hidden file",
  type: "not a picture, font, style or script",
  missing: "could not be read",
  too_large: "page would pass 5 MB",
};

interface Props {
  anchorRef: React.RefObject<HTMLElement | null>;
  path: string;
  getText: () => string;
  onClose: () => void;
}

export default function SharePopover({ anchorRef, path, getText, onClose }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "preparing" });
  const [ttlDays, setTtlDays] = useState<ShareExpiryDays>(SHARE_DEFAULT_EXPIRY_DAYS);
  // The text as it was when the prompt opened: the page the user is looking
  // at, even if they keep typing behind the prompt.
  const textRef = useRef<string | null>(null);
  textRef.current ??= getText();

  useEffect(() => {
    let cancelled = false;
    void packageForShare(
      { path, text: textRef.current ?? "", workspaceRoots: shareWorkspaceRoots() },
      appPackageDeps(),
    ).then(
      (page) => {
        if (!cancelled) setStage({ kind: "ready", page });
      },
      (err: unknown) => {
        if (!cancelled) setStage({ kind: "failed", message: shareErrorText(err), page: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  const share = async (page: PackagedShare) => {
    setStage({ kind: "uploading", page });
    try {
      const shared = await window.spark.share.create({ html: page.html, title: page.title, ttlDays });
      let copied = false;
      try {
        await window.spark.clipboard.writeText(shared.url);
        copied = true;
      } catch {
        // The link is on screen with its own Copy button.
      }
      setStage({ kind: "done", page, shared, copied });
    } catch (err) {
      setStage({ kind: "failed", message: shareErrorText(err), page });
    }
  };

  const copy = async (shared: SharedPage, page: PackagedShare) => {
    try {
      await window.spark.clipboard.writeText(shared.url);
      setStage({ kind: "done", page, shared, copied: true });
    } catch {
      /* the link stays selectable in the field */
    }
  };

  const name = useMemo(() => path.replace(/\\/g, "/").split("/").pop() ?? path, [path]);

  return (
    <AnchoredMenu
      anchorRef={anchorRef}
      open
      onClose={onClose}
      className="spark-menu share-pop"
      role="dialog"
      ariaLabel="Share as link"
      placement="below"
      align="end"
      focusSignal={stage.kind}
    >
      <div className="share-pop__head">
        <span className="share-pop__title">Share as link</span>
      </div>
      <div className="share-pop__file">
        <span className="share-pop__name" title={path}>
          {name}
        </span>
        {"page" in stage && stage.page && (
          <span className="share-pop__size">{formatShareBytes(stage.page.bytes)}</span>
        )}
      </div>

      {stage.kind === "preparing" && <p className="share-pop__note">Preparing the page...</p>}

      {(stage.kind === "ready" || stage.kind === "uploading") && (
        <ReadyBody
          page={stage.page}
          ttlDays={ttlDays}
          onTtl={setTtlDays}
          busy={stage.kind === "uploading"}
          onCancel={onClose}
          onShare={() => void share(stage.page)}
        />
      )}

      {stage.kind === "done" && (
        <div className="share-pop__body">
          <p className="share-pop__status">{stage.copied ? "Link copied." : "Your link is ready."}</p>
          <div className="share-pop__link">
            <input
              className="spark-input share-pop__url"
              readOnly
              value={stage.shared.url}
              aria-label="Shared link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="spark-btn" onClick={() => void copy(stage.shared, stage.page)}>
              Copy
            </button>
          </div>
          <p className="share-pop__note">
            Expires on {new Date(stage.shared.expiresAt).toLocaleDateString()}. Change or delete it in Settings, Shared
            pages.
          </p>
          <div className="share-pop__actions">
            <button type="button" className="spark-btn" onClick={() => void window.spark.openExternal(stage.shared.url)}>
              Open
            </button>
            <button type="button" className="spark-btn is-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}

      {stage.kind === "failed" && (
        <div className="share-pop__body">
          <p className="share-pop__error" role="alert">
            {stage.message}
          </p>
          <div className="share-pop__actions">
            <button type="button" className="spark-btn" onClick={onClose}>
              Close
            </button>
            {stage.page && (
              <button type="button" className="spark-btn is-primary" onClick={() => void share(stage.page!)}>
                Try again
              </button>
            )}
          </div>
        </div>
      )}
    </AnchoredMenu>
  );
}

function ReadyBody({
  page,
  ttlDays,
  onTtl,
  busy,
  onCancel,
  onShare,
}: {
  page: PackagedShare;
  ttlDays: ShareExpiryDays;
  onTtl: (days: ShareExpiryDays) => void;
  busy: boolean;
  onCancel: () => void;
  onShare: () => void;
}) {
  const tooLarge = page.bytes > SHARE_MAX_PAGE_BYTES;
  return (
    <div className="share-pop__body">
      {page.included.length > 0 && (
        <details className="share-pop__details">
          <summary>
            Includes {page.included.length} {page.included.length === 1 ? "file" : "files"} from this computer.
          </summary>
          <ul>
            {page.included.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </details>
      )}
      {page.leftOut.length > 0 && (
        <details className="share-pop__details">
          <summary>
            Left out {page.leftOut.length} {page.leftOut.length === 1 ? "file" : "files"}.
          </summary>
          <ul>
            {page.leftOut.map((entry, index) => (
              <li key={`${entry.ref}-${index}`}>
                {entry.ref} ({LEFT_OUT_REASON[entry.reason] ?? entry.reason})
              </li>
            ))}
          </ul>
        </details>
      )}
      {page.remote > 0 && (
        <p className="share-pop__note">
          {page.remote} {page.remote === 1 ? "file" : "files"} from other sites will not load on the shared page.
        </p>
      )}
      {page.removed > 0 && (
        <p className="share-pop__note">
          Removed {page.removed} {page.removed === 1 ? "link or frame" : "links or frames"} that only work on this
          computer.
        </p>
      )}
      {tooLarge ? (
        <p className="share-pop__error" role="alert">
          This page is {formatShareBytes(page.bytes)}. A shared page can be at most 5 MB.
        </p>
      ) : (
        <>
          <div className="share-pop__field">
            <span className="share-pop__label" id="share-expiry-label">
              Link expires after
            </span>
            <div className="share-pop__segments" role="radiogroup" aria-labelledby="share-expiry-label">
              {SHARE_EXPIRY_CHOICES.map((days) => (
                <button
                  key={days}
                  type="button"
                  role="radio"
                  aria-checked={ttlDays === days}
                  className={`share-pop__segment${ttlDays === days ? " is-active" : ""}`}
                  onClick={() => onTtl(days)}
                  disabled={busy}
                >
                  {days} days
                </button>
              ))}
            </div>
          </div>
          <p className="share-pop__warning">Anyone with the link can open this page.</p>
        </>
      )}
      <div className="share-pop__actions">
        <button type="button" className="spark-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="spark-btn is-primary" onClick={onShare} disabled={busy || tooLarge}>
          {busy ? "Sharing..." : "Share"}
        </button>
      </div>
    </div>
  );
}
