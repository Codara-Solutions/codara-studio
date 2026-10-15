import React from "react";
import { splitSnippetMarks } from "@shared/session-search";

/** A snippet from the index, its matched words marked. */
export function SnippetText({ snippet }: { snippet: string }) {
  return (
    <>
      {splitSnippetMarks(snippet).map((part, index) =>
        part.mark ? (
          <mark key={index} className="ss-hl">
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        ),
      )}
    </>
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Plain text with every query word marked wherever it appears. */
export function TermsText({ text, terms }: { text: string; terms: readonly string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="ss-hl">
            {part}
          </mark>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}
