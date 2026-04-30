import React, { useEffect, useState } from "react";
import type { GitBranch } from "@shared/types";

interface Props {
  cwd: string | null;
}

export default function GitGraph({ cwd }: Props) {
  const [loading, setLoading] = useState(false);
  const [branch, setBranch] = useState<string | undefined>();
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [isRepo, setIsRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) {
      setIsRepo(false);
      setBranch(undefined);
      setBranches([]);
      setRemoteBranches([]);
      setLines([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        if (!window.spark.git?.graph) {
          throw new Error("Git API unavailable. Restart Spark Agent to load the updated preload.");
        }
        const graph = await window.spark.git.graph(cwd);
        if (cancelled) return;
        setIsRepo(graph.isRepo);
        setBranch(graph.branch);
        setBranches(graph.branches ?? []);
        setRemoteBranches(graph.remoteBranches ?? []);
        setLines(graph.lines);
        setError(graph.error ?? null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return (
    <section
      style={{
        flex: "1 1 50%",
        minHeight: 0,
        borderTop: "1px solid var(--rule-soft)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "10px 14px 6px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "var(--muted)",
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          GIT
        </span>
        {branch && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--ink-dim)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
            title={branch}
          >
            {branch}
          </span>
        )}
        <span style={{ flex: 1, height: 1, background: "var(--rule-soft)" }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {loading ? "..." : String(branches.length).padStart(2, "0")}
        </span>
      </div>

      <div style={{ padding: "0 0 8px", overflow: "auto", flex: 1, minHeight: 0 }}>
        {!cwd ? (
          <Message text="No active workspace." />
        ) : error ? (
          <Message text={error} danger />
        ) : !isRepo ? (
          <Message text="No git repository." />
        ) : (
          <>
            <BranchSummary branch={branch} branches={branches} remoteBranches={remoteBranches} />
            {lines.length === 0 ? (
              <Message text={branch ? `${branch}: no commits yet` : "No commits yet."} />
            ) : (
              <div style={{ padding: "8px 8px 0 10px", borderTop: "1px solid var(--rule)" }}>
                {lines.map((line, index) => (
                  <GraphLine key={`${index}-${line}`} line={line} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function BranchSummary({
  branch,
  branches,
  remoteBranches,
}: {
  branch?: string;
  branches: GitBranch[];
  remoteBranches: string[];
}) {
  const current = branches.find((item) => item.current);
  return (
    <div style={{ padding: "0 10px 10px" }}>
      <div
        style={{
          padding: "8px 4px 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <BranchGlyph active />
        <span
          title={branch}
          style={{
            minWidth: 0,
            flex: 1,
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {branch || "detached"}
        </span>
        {current && <SyncBadge branch={current} />}
      </div>

      <MiniSection label="LOCAL" count={branches.length} />
      {branches.length === 0 ? (
        <MiniMessage text="No local branches." />
      ) : (
        branches.slice(0, 8).map((item) => <BranchRow key={item.name} branch={item} />)
      )}

      <MiniSection label="REMOTES" count={remoteBranches.length} />
      {remoteBranches.length === 0 ? (
        <MiniMessage text="No remote branches." />
      ) : (
        remoteBranches.slice(0, 8).map((name) => <RemoteBranchRow key={name} name={name} />)
      )}
    </div>
  );
}

function MiniSection({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 4px 4px",
        color: "var(--muted)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--rule-soft)" }} />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {String(count).padStart(2, "0")}
      </span>
    </div>
  );
}

function BranchRow({ branch }: { branch: GitBranch }) {
  return (
    <div
      title={branch.upstream ? `${branch.name} -> ${branch.upstream}` : branch.name}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        padding: "4px 4px",
        color: branch.current ? "var(--ink)" : "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <BranchGlyph active={branch.current} />
      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {branch.name}
      </span>
      {(branch.ahead > 0 || branch.behind > 0) && (
        <span
          style={{
            display: "inline-flex",
            gap: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {branch.behind > 0 && (
            <span style={{ color: "var(--danger)" }}>↓{branch.behind}</span>
          )}
          {branch.ahead > 0 && (
            <span style={{ color: "var(--accent)" }}>↑{branch.ahead}</span>
          )}
        </span>
      )}
    </div>
  );
}

function RemoteBranchRow({ name }: { name: string }) {
  return (
    <div
      title={name}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        padding: "4px 4px",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <BranchGlyph />
      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
    </div>
  );
}

function BranchGlyph({ active = false }: { active?: boolean }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        border: `1px solid ${active ? "var(--accent)" : "var(--rule-strong)"}`,
        background: active ? "var(--accent)" : "transparent",
        flex: "0 0 8px",
      }}
    />
  );
}

function SyncBadge({ branch }: { branch: GitBranch }) {
  const { text, color } = (() => {
    if (branch.behind > 0 && branch.ahead > 0) return { text: `PULL ${branch.behind} / PUSH ${branch.ahead}`, color: "var(--danger)" };
    if (branch.behind > 0) return { text: `PULL ${branch.behind}`, color: "var(--danger)" };
    if (branch.ahead > 0) return { text: `PUSH ${branch.ahead}`, color: "var(--accent)" };
    if (!branch.upstream) return { text: "NO UPSTREAM", color: "var(--muted)" };
    return { text: "SYNCED", color: "var(--ok)" };
  })();

  return (
    <span
      title={branch.upstream}
      style={{
        flex: "0 0 auto",
        border: "1px solid var(--rule-soft)",
        padding: "2px 6px",
        color,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function MiniMessage({ text }: { text: string }) {
  return <div style={{ padding: "4px", color: "var(--muted)", fontSize: 10 }}>{text}</div>;
}

function GraphLine({ line }: { line: string }) {
  const parsed = parseGraphLine(line);
  return (
    <div
      title={line}
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr)",
        gap: 8,
        alignItems: "baseline",
        minWidth: 0,
        padding: "2px 0",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1.4,
      }}
    >
      <span
        style={{
          color: "var(--accent)",
          whiteSpace: "pre",
          fontWeight: 700,
        }}
      >
        {parsed.graph}
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {parsed.hash && (
          <span style={{ color: "var(--info)", fontWeight: 600, marginRight: 8, fontVariantNumeric: "tabular-nums" }}>{parsed.hash}</span>
        )}
        {parsed.decorate && (
          <span style={{ color: "var(--ok)", marginRight: 8 }}>{parsed.decorate}</span>
        )}
        <span style={{ color: "var(--ink-dim)", fontFamily: "var(--font-sans)" }}>{parsed.subject}</span>
      </span>
    </div>
  );
}

function Message({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div style={{ padding: "10px 14px", color: danger ? "var(--danger)" : "var(--muted)", fontSize: 11 }}>
      {text}
    </div>
  );
}

function parseGraphLine(line: string): { graph: string; hash?: string; decorate?: string; subject: string } {
  const match = line.match(/^([|*\\/_\s.-]*?)([0-9a-f]{7,40})(?:\s+\(([^)]*)\))?\s*(.*)$/i);
  if (!match) return { graph: line, subject: "" };
  return {
    graph: match[1] || "",
    hash: match[2],
    decorate: match[3],
    subject: match[4] || "",
  };
}
