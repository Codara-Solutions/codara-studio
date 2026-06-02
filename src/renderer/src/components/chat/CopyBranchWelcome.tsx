import type { Workspace } from "@shared/types";

// Conductor-style provenance banner shown in the Spark chat when a freshly
// created copy-branch workspace has no conversation yet. Mirrors Conductor's
// three lines: "You're in a new copy of <repo> called <city>", "Branched
// <branch> from <base>", and "Created <city> and copied N files".

type CopyBranch = NonNullable<Workspace["copyBranch"]>;

function repoName(repoCwd: string): string {
  const parts = repoCwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? repoCwd;
}

export default function CopyBranchWelcome({ copyBranch }: { copyBranch: CopyBranch }) {
  const repo = repoName(copyBranch.repoCwd);
  const files = typeof copyBranch.fileCount === "number" ? copyBranch.fileCount.toLocaleString("en-US") : null;
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "20px 18px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          background: "var(--panel-2)",
          border: "1px solid var(--rule-soft)",
          borderRadius: 10,
          padding: "12px 14px",
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--ink)",
          boxShadow: "var(--lift-hi)",
        }}
      >
        You're in a new copy of <Mono>{repo}</Mono> called <Mono accent>{copyBranch.city}</Mono>
      </div>

      <Line icon={<BranchIcon />}>
        Branched <Mono accent>{copyBranch.branch}</Mono> from <Mono>{copyBranch.baseBranch}</Mono>
      </Line>

      <Line icon={<FolderIcon />}>
        Created <Mono accent>{copyBranch.city}</Mono>
        {files !== null ? (
          <>
            {" "}
            and copied <Mono>{files}</Mono> files
          </>
        ) : null}
      </Line>
    </div>
  );
}

function Line({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 12.5,
        color: "var(--ink-dim)",
        padding: "0 2px",
      }}
    >
      <span
        aria-hidden
        style={{ flex: "0 0 16px", display: "grid", placeItems: "center", color: "var(--muted)" }}
      >
        {icon}
      </span>
      <span>{children}</span>
    </div>
  );
}

function Mono({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <code
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.92em",
        padding: "1px 5px",
        borderRadius: 5,
        background: accent
          ? "color-mix(in oklch, var(--accent) 16%, transparent)"
          : "color-mix(in oklch, var(--ink) 7%, transparent)",
        color: accent ? "var(--accent)" : "var(--ink)",
        border: accent ? "1px solid var(--accent-edge)" : "1px solid var(--rule-soft)",
      }}
    >
      {children}
    </code>
  );
}

function BranchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}
