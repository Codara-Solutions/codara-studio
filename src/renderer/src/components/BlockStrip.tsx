import React, { useEffect, useState } from "react";
import type { ShellBlock, ShellIntegration, ShellIntegrationState } from "../terminal/shell-integration";

interface Props {
  integration: ShellIntegration | null;
  onCopy?: (text: string) => void;
}

const MAX_VISIBLE_BLOCKS = 20;

export default function BlockStrip({ integration, onCopy }: Props) {
  const [state, setState] = useState<ShellIntegrationState>({ blocks: [], altScreen: false });

  useEffect(() => {
    if (!integration) {
      setState({ blocks: [], altScreen: false });
      return;
    }
    return integration.subscribe(setState);
  }, [integration]);

  if (!integration) return null;
  if (state.altScreen) return <AltScreenPill />;
  if (state.blocks.length === 0) return null;

  const blocks = state.blocks.slice(-MAX_VISIBLE_BLOCKS);

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        overflowX: "auto",
        overflowY: "hidden",
        padding: "4px 6px",
        borderBottom: "1px solid var(--rule)",
        background: "var(--panel)",
        flex: "0 0 auto",
        scrollbarWidth: "thin",
      }}
    >
      {blocks.map((block) => (
        <BlockChip key={block.id} block={block} onCopy={onCopy} />
      ))}
    </div>
  );
}

function BlockChip({ block, onCopy }: { block: ShellBlock; onCopy?: (text: string) => void }) {
  const tone = chipTone(block);
  const cmd = block.command || "(empty)";
  const elapsed = block.finishedAt
    ? formatElapsed(block.finishedAt - block.startedAt)
    : formatElapsed(Date.now() - block.startedAt);
  const tooltip = block.command
    ? `${block.command}${block.exitCode !== undefined ? `\nexit ${block.exitCode}` : ""}`
    : "(no command captured)";

  return (
    <div
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 7px",
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        flex: "0 0 auto",
        maxWidth: 260,
        fontSize: 10,
        lineHeight: 1.2,
        color: "var(--ink-dim)",
      }}
    >
      <StatusDot status={block.status} exitCode={block.exitCode} />
      <span
        style={{
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          color: "var(--ink)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {cmd}
      </span>
      {block.exitCode !== undefined && block.exitCode !== 0 && (
        <span style={{ color: "var(--danger)", fontWeight: 700 }}>{block.exitCode}</span>
      )}
      <span style={{ color: "var(--muted)", fontSize: 9 }}>{elapsed}</span>
      {onCopy && block.command && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCopy(block.command);
          }}
          title="Copy command"
          style={{
            appearance: "none",
            background: "transparent",
            border: "none",
            color: "var(--muted)",
            padding: 0,
            cursor: "default",
            fontSize: 10,
            lineHeight: 1,
          }}
        >
          ⧉
        </button>
      )}
    </div>
  );
}

function StatusDot({ status, exitCode }: { status: ShellBlock["status"]; exitCode?: number }) {
  const color =
    status === "running"
      ? "var(--accent)"
      : status === "aborted"
        ? "var(--muted)"
        : exitCode === undefined || exitCode === 0
          ? "var(--ok)"
          : "var(--danger)";
  return (
    <span
      style={{
        width: 6,
        height: 6,
        background: color,
        flex: "0 0 auto",
        animation: status === "running" ? "spark-pulse 1.2s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function AltScreenPill() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        borderBottom: "1px solid var(--rule)",
        background: "var(--panel)",
        flex: "0 0 auto",
        fontSize: 10,
        color: "var(--muted)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        fontWeight: 700,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          background: "var(--accent)",
          animation: "spark-pulse 1.2s ease-in-out infinite",
        }}
      />
      <span>TUI session — full-screen app</span>
    </div>
  );
}

function chipTone(block: ShellBlock): { bg: string; border: string } {
  if (block.status === "running") {
    return { bg: "rgba(240, 196, 25, 0.06)", border: "var(--accent)" };
  }
  if (block.status === "aborted") {
    return { bg: "transparent", border: "var(--rule-strong)" };
  }
  if (block.exitCode !== undefined && block.exitCode !== 0) {
    return { bg: "rgba(255, 110, 110, 0.06)", border: "var(--danger)" };
  }
  return { bg: "transparent", border: "var(--rule-strong)" };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s - m * 60);
  return `${m}m${rs}s`;
}
