import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { SHARE_OFFER_EVENT, clearShareOffer, pendingShareOffer } from "./offer-store";

// The editor toolbar's Share button for HTML and Markdown files. It also opens
// its prompt when an agent offered this file (codara_share_offer); either way
// nothing is uploaded until the user clicks Share in the prompt.

const SharePopover = lazy(() => import("./SharePopover"));

export default function ShareButton({
  path,
  getText,
  style,
}: {
  path: string;
  getText: () => string;
  style: React.CSSProperties;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (pendingShareOffer(path)) setOpen(true);
    const onOffer = (event: Event) => {
      const offered = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (offered === path && pendingShareOffer(path)) setOpen(true);
    };
    window.addEventListener(SHARE_OFFER_EVENT, onOffer);
    return () => window.removeEventListener(SHARE_OFFER_EVENT, onOffer);
  }, [path]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => {
          if (open) clearShareOffer(path);
          setOpen(!open);
        }}
        title="Share as link"
        aria-label="Share as link"
        aria-haspopup="dialog"
        aria-expanded={open}
        style={style}
      >
        <ShareIcon />
      </button>
      {open && (
        <Suspense fallback={null}>
          <SharePopover
            anchorRef={anchorRef}
            path={path}
            getText={getText}
            onClose={() => {
              clearShareOffer(path);
              setOpen(false);
            }}
          />
        </Suspense>
      )}
    </>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 10V2.5M8 2.5 5.25 5.25M8 2.5l2.75 2.75M4 7.5H3.5A1.5 1.5 0 0 0 2 9v4a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V9a1.5 1.5 0 0 0-1.5-1.5H12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
