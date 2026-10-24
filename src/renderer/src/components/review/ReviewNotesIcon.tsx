import React from "react";

// The review's icon, in a file of its own: Source Control draws it in its
// header at startup, while the review screen itself loads only when opened.
/** A speech bubble over lines: the review tab's button in Source Control. */
export function ReviewNotesIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 3.2a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v5.3a1 1 0 0 1-1 1H6.2L3.8 11.6V9.5h-.3a1 1 0 0 1-1-1V3.2Z" />
      <path d="M5 5.2h4M5 7.1h2.6" />
    </svg>
  );
}
