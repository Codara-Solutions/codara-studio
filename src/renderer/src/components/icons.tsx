import React from "react";

const wrap = (children: React.ReactNode, color = "currentColor", size = 14) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: size,
      height: size,
      flex: `0 0 ${size}px`,
      color,
    }}
  >
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      {children}
    </svg>
  </span>
);

export function FolderIcon({ open = false }: { open?: boolean }) {
  return wrap(
    open ? (
      <>
        <path d="M1 4 H6 L7.5 5.5 H13 V12 H1 Z" stroke="currentColor" strokeWidth="1" />
        <path d="M1 5.5 H13" stroke="currentColor" strokeWidth="1" />
      </>
    ) : (
      <path d="M1 4 H5.5 L7 5.5 H13 V12 H1 Z" stroke="currentColor" strokeWidth="1" />
    ),
    "var(--accent)",
  );
}

const docFrame = (
  <path d="M3 1.5 H9 L11 3.5 V12.5 H3 Z M9 1.5 V3.5 H11" stroke="currentColor" strokeWidth="1" />
);

export function FileIcon({ ext }: { ext?: string }) {
  switch (ext) {
    case "ts":
    case "tsx":
      return wrap(
        <>
          {docFrame}
          <path d="M4.5 7 H7 M5.75 7 V10.5" stroke="currentColor" strokeWidth="1" />
          <path d="M9.5 7 H8 V8.5 H9.5 V10.5 H8" stroke="currentColor" strokeWidth="1" fill="none" />
        </>,
        "var(--info)",
      );
    case "js":
    case "jsx":
      return wrap(
        <>
          {docFrame}
          <path d="M5 7 V10 Q5 11 6 11 Q7 11 7 10 V7" stroke="currentColor" strokeWidth="1" fill="none" />
          <path d="M8 10 Q8 11 9 11 Q10 11 10 10 V9 H8.5 V8 Q8.5 7 9.5 7"
                stroke="currentColor" strokeWidth="1" fill="none" />
        </>,
        "var(--accent)",
      );
    case "json":
      return wrap(
        <>
          {docFrame}
          <path
            d="M6 7 Q5 7 5 8 V8.5 Q5 9 4.5 9 Q5 9 5 9.5 V10 Q5 11 6 11"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
          <path
            d="M8 7 Q9 7 9 8 V8.5 Q9 9 9.5 9 Q9 9 9 9.5 V10 Q9 11 8 11"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
        </>,
        "var(--accent)",
      );
    case "yaml":
    case "yml":
      return wrap(
        <>
          {docFrame}
          <path d="M5 7 L7 9 L9 7 M7 9 V11" stroke="currentColor" strokeWidth="1" fill="none" />
        </>,
        "var(--ink-dim)",
      );
    case "md":
      return wrap(
        <>
          {docFrame}
          <path d="M5 11 V7 L7 9.5 L9 7 V11" stroke="currentColor" strokeWidth="1" fill="none" />
        </>,
        "var(--ink-dim)",
      );
    case "env":
      return wrap(
        <>
          {docFrame}
          <circle cx="7" cy="9" r="1.4" stroke="currentColor" strokeWidth="1" fill="none" />
          <path
            d="M7 6.5 V7.5 M7 10.5 V11.5 M4.5 9 H5.5 M8.5 9 H9.5"
            stroke="currentColor"
            strokeWidth="1"
          />
        </>,
        "var(--muted)",
      );
    default:
      return wrap(
        <>
          {docFrame}
          <line x1="4.5" y1="7.5" x2="9.5" y2="7.5" stroke="currentColor" strokeWidth="1" />
          <line x1="4.5" y1="9" x2="9.5" y2="9" stroke="currentColor" strokeWidth="1" />
          <line x1="4.5" y1="10.5" x2="7.5" y2="10.5" stroke="currentColor" strokeWidth="1" />
        </>,
        "var(--muted)",
      );
  }
}

export function PlusIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <line x1="6" y1="2" x2="6" y2="10" />
      <line x1="2" y1="6" x2="10" y2="6" />
    </svg>
  );
}

export function CloseIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
      <line x1="2" y1="2" x2="8" y2="8" />
      <line x1="8" y1="2" x2="2" y2="8" />
    </svg>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 12,
        color: "var(--muted)",
        fontWeight: 800,
      }}
    >
      {open ? "▾" : "▸"}
    </span>
  );
}
