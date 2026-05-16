import React, { useEffect, useState } from "react";
import type { GitBranch } from "@shared/types";

interface Props {
  cwd: string | null;
}

const VSCODE_LOCAL_REF_COLOR = "#59a4f9";
const VSCODE_REMOTE_REF_COLOR = "#B180D7";
const VSCODE_BASE_REF_COLOR = "#EA5C00";
const VSCODE_GRAPH_COLORS = ["#FFB000", "#DC267F", "#994F00", "#40B0A6", "#B66DFF"];
const SCM_SWIMLANE_HEIGHT = 22;
const SCM_SWIMLANE_WIDTH = 11;
const SCM_NODE_RADIUS = 4;

export default function GitGraph({ cwd }: Props) {
  const [loading, setLoading] = useState(false);
  const [branch, setBranch] = useState<string | undefined>();
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [isRepo, setIsRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) {
      setIsRepo(false);
      setBranch(undefined);
      setBranches([]);
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

  const current = branches.find((item) => item.current);

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
      <GraphToolbar />

      <div style={{ padding: "0 0 8px", overflow: "auto", flex: 1, minHeight: 0 }}>
        {!cwd ? (
          <Message text="No active workspace." />
        ) : error ? (
          <Message text={error} danger />
        ) : !isRepo ? (
          <Message text="No git repository." />
        ) : (
          <>
            <GraphGroup branch={branch} current={current} loading={loading} count={branches.length} />
            {lines.length === 0 ? (
              <Message text={branch ? `${branch}: no commits yet` : "No commits yet."} />
            ) : (
              <div style={{ padding: "0 6px 0 0" }}>
                {lines.map((line, index) => {
                  // Key on the commit hash so a row's identity is stable
                  // when the graph reorders (the array index is not).
                  // Connector-only lines have no hash — fall back to the
                  // index there so the keys stay unique.
                  const hash = parseGraphLine(line).hash;
                  return (
                    <CommitRow
                      key={hash ?? `connector-${index}`}
                      line={line}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function GraphToolbar() {
  return (
    <div
      style={{
        height: 30,
        padding: "0 8px 0 10px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        color: "var(--muted)",
        flex: "0 0 auto",
      }}
    >
      <span style={{ color: "var(--muted-2)", fontSize: 13, lineHeight: 1 }}>⌄</span>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          fontWeight: 800,
        }}
      >
        GRAPH
      </span>
      <span style={{ flex: 1 }} />
      <span
        title="Auto refresh"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          color: "var(--muted)",
        }}
      >
        <BranchIcon />
        Auto
      </span>
      <ToolbarButton title="Refresh">↻</ToolbarButton>
      <ToolbarButton title="More">•••</ToolbarButton>
    </div>
  );
}

function ToolbarButton({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <button
      type="button"
      title={title}
      style={{
        appearance: "none",
        width: 20,
        height: 20,
        border: "none",
        background: "transparent",
        color: "var(--muted)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        cursor: "default",
      }}
    >
      {children}
    </button>
  );
}

function GraphGroup({
  branch,
  current,
  loading,
  count,
}: {
  branch?: string;
  current?: GitBranch;
  loading: boolean;
  count: number;
}) {
  const label = current?.ahead && current.ahead > 0
    ? "Outgoing Changes"
    : current?.behind && current.behind > 0
      ? "Incoming Changes"
      : "Commit Graph";

  return (
    <div
      style={{
        height: 24,
        padding: "0 10px 0 12px",
        display: "flex",
        alignItems: "center",
        gap: 6,
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          border: "1px solid var(--rule-strong)",
          flex: "0 0 7px",
        }}
      />
      <span style={{ color: "var(--ink-dim)", whiteSpace: "nowrap" }}>{label}</span>
      {branch && (
        <span
          title={branch}
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {branch}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {loading ? "..." : String(count).padStart(2, "0")}
      </span>
    </div>
  );
}

// Memoized: the graph re-renders whenever GitGraph's state changes, but a
// row is a pure function of its `line` string. Shallow prop compare lets
// untouched rows skip the parse + render entirely.
const CommitRow = React.memo(function CommitRow({ line }: { line: string }) {
  const parsed = parseGraphLine(line);
  const refs = decorationRefs(parsed.decorate);

  return (
    <div
      title={line}
      style={{
        display: "grid",
        gridTemplateColumns: "max-content minmax(0, 1fr)",
        gap: 8,
        alignItems: "center",
        minWidth: 0,
        minHeight: 23,
        padding: "0 6px 0 0",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <GraphLane graph={parsed.graph} refs={refs} />
      <span
        style={{
          minWidth: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            color: "var(--ink-dim)",
            fontFamily: "var(--font-sans)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {parsed.subject || "Commit"}
        </span>
        {parsed.hash && (
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              flex: "0 0 auto",
            }}
          >
            {parsed.hash}
          </span>
        )}
        {refs.map((ref) => (
          <RefBadge key={ref} refName={ref} />
        ))}
      </span>
    </div>
  );
});

function GraphLane({ graph, refs }: { graph: string; refs: string[] }) {
  const tokens = (graph.trimEnd() || "*").split("");
  return (
    <span
      aria-hidden
      style={{
        height: SCM_SWIMLANE_HEIGHT,
        display: "inline-flex",
        alignItems: "stretch",
      }}
    >
      {tokens.map((token, index) => {
        const color = graphTokenColor(tokens, index, refs);
        return (
          <GraphToken
            key={`${index}-${token}`}
            token={token}
            color={color}
            featured={token === "*" && refs.length > 0}
          />
        );
      })}
    </span>
  );
}

function GraphToken({
  token,
  color,
  featured,
}: {
  token: string;
  color: string;
  featured: boolean;
}) {
  if (token === "*") {
    return (
      <span
        style={{
          width: SCM_SWIMLANE_WIDTH,
          height: "100%",
          position: "relative",
          flex: `0 0 ${SCM_SWIMLANE_WIDTH}px`,
        }}
      >
        <span
          style={{
            position: "absolute",
            left: Math.floor(SCM_SWIMLANE_WIDTH / 2),
            top: 0,
            bottom: 0,
            width: 2,
            background: lineColor(color),
            opacity: 0.72,
          }}
        />
        <span
          style={{
            position: "absolute",
            left: Math.floor(SCM_SWIMLANE_WIDTH / 2) - (featured ? SCM_NODE_RADIUS : SCM_NODE_RADIUS - 1),
            top: "50%",
            width: featured ? SCM_NODE_RADIUS * 2 : (SCM_NODE_RADIUS - 1) * 2,
            height: featured ? SCM_NODE_RADIUS * 2 : (SCM_NODE_RADIUS - 1) * 2,
            marginTop: featured ? -SCM_NODE_RADIUS : -(SCM_NODE_RADIUS - 1),
            borderRadius: 999,
            border: `1px solid ${color}`,
            background: featured ? color : "var(--panel)",
            boxShadow: featured ? `0 0 7px ${softGlow(color)}` : "none",
          }}
        />
      </span>
    );
  }

  if (token === "|") return <GraphRail color={color} />;
  if (token === "/" || token === "\\") return <GraphDiagonal direction={token} color={color} />;
  if (token === "_" || token === "-") return <GraphHorizontal color={color} />;
  return <span style={{ width: SCM_SWIMLANE_WIDTH, flex: `0 0 ${SCM_SWIMLANE_WIDTH}px` }} />;
}

function GraphRail({ color }: { color: string }) {
  return (
    <span
      style={{
        width: SCM_SWIMLANE_WIDTH,
        height: "100%",
        position: "relative",
        flex: `0 0 ${SCM_SWIMLANE_WIDTH}px`,
      }}
    >
      <span
        style={{
          position: "absolute",
          left: Math.floor(SCM_SWIMLANE_WIDTH / 2),
          top: 0,
          bottom: 0,
          width: 2,
          background: lineColor(color),
          opacity: 0.72,
        }}
      />
    </span>
  );
}

function GraphDiagonal({ direction, color }: { direction: "/" | "\\"; color: string }) {
  return (
    <span
      style={{
        width: SCM_SWIMLANE_WIDTH,
        height: "100%",
        position: "relative",
        flex: `0 0 ${SCM_SWIMLANE_WIDTH}px`,
      }}
    >
      <span
        style={{
          position: "absolute",
          left: Math.floor(SCM_SWIMLANE_WIDTH / 2),
          top: 2,
          width: 2,
          height: SCM_SWIMLANE_HEIGHT - 4,
          background: lineColor(color),
          opacity: 0.72,
          transform: direction === "/" ? "rotate(28deg)" : "rotate(-28deg)",
          transformOrigin: "center",
        }}
      />
    </span>
  );
}

function GraphHorizontal({ color }: { color: string }) {
  return (
    <span
      style={{
        width: SCM_SWIMLANE_WIDTH,
        height: "100%",
        position: "relative",
        flex: `0 0 ${SCM_SWIMLANE_WIDTH}px`,
      }}
    >
      <span
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "50%",
          height: 2,
          background: lineColor(color),
          opacity: 0.72,
        }}
      />
    </span>
  );
}

function RefBadge({ refName }: { refName: string }) {
  const remote = refName.includes("/");
  const base = refName === "base";
  const fg = base ? VSCODE_BASE_REF_COLOR : remote ? VSCODE_REMOTE_REF_COLOR : VSCODE_LOCAL_REF_COLOR;

  return (
    <span
      title={refName}
      style={{
        maxWidth: 92,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        border: `1px solid color-mix(in oklch, ${fg} 58%, var(--rule-soft))`,
        borderRadius: 999,
        padding: "1px 6px",
        color: fg,
        background: `color-mix(in oklch, ${fg} 14%, transparent)`,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 600,
        flex: "0 0 auto",
      }}
    >
      @{refName}
    </span>
  );
}

function BranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="3" cy="3" r="1.4" stroke="currentColor" strokeWidth="1" />
      <circle cx="8.5" cy="8.5" r="1.4" stroke="currentColor" strokeWidth="1" />
      <path d="M3 4.4v1.2c0 1.5 1.1 2.9 2.6 2.9h1.5" stroke="currentColor" strokeWidth="1" />
      <path d="M3 5.2c1.8 0 2.3-1.7 3.7-1.7H8" stroke="currentColor" strokeWidth="1" />
    </svg>
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

function decorationRefs(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().replace(/^tag:\s*/, ""))
    .flatMap((item) => {
      if (!item) return [];
      if (item.includes(" -> ")) return item.split(" -> ").slice(1);
      if (item === "HEAD") return [];
      return [item];
    })
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 2);
}

function graphTokenColor(tokens: string[], tokenIndex: number, refs: string[]): string {
  const token = tokens[tokenIndex];
  if (token === "*") {
    return refColor(refs) ?? laneColor(laneIndex(tokens, tokenIndex));
  }
  return laneColor(laneIndex(tokens, tokenIndex));
}

function refColor(refs: string[]): string | undefined {
  if (refs.some((ref) => ref.includes("/"))) return VSCODE_REMOTE_REF_COLOR;
  if (refs.some((ref) => ref === "base")) return VSCODE_BASE_REF_COLOR;
  if (refs.length > 0) return VSCODE_LOCAL_REF_COLOR;
  return undefined;
}

function laneColor(index: number): string {
  return VSCODE_GRAPH_COLORS[index % VSCODE_GRAPH_COLORS.length];
}

function laneIndex(tokens: string[], tokenIndex: number): number {
  let lane = 0;
  for (let i = 0; i < tokenIndex; i++) {
    if (tokens[i] !== " ") lane++;
  }
  return lane;
}

function lineColor(color: string): string {
  return `color-mix(in oklch, ${color} 38%, var(--rule-soft))`;
}

function softGlow(color: string): string {
  return `color-mix(in oklch, ${color} 44%, transparent)`;
}
