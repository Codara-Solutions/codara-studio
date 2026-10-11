import React, { useState } from "react";
import type { CoraMemoryScope, CoraMemoryStatus, CoraProfile, MemoryTierStatus } from "@shared/types";
import { formatMemoryBytes, memoryTone } from "./model";
import {
  ErrorRow,
  Switch,
  cellLabelStyle,
  listStyle,
  microBtnStyle,
  rowMetaStyle,
  rowNameStyle,
  rowNoteStyle,
  rowStyle,
  sectionStyle,
  smallBtnStyle,
} from "./controls";
import { shortPath } from "./McpSection";
import CustomSelect from "../settings/CustomSelect";

export default function MemorySection({
  profiles,
  viewedProfileId,
  onViewProfile,
  memory,
  memoryError,
  onRetry,
  busy,
  workspaceAvailable,
  onToggle,
  onOpen,
  onClear,
}: {
  profiles: CoraProfile[];
  viewedProfileId: string | null;
  onViewProfile: (profileId: string) => void;
  memory: CoraMemoryStatus | null;
  memoryError: string | null;
  onRetry: () => void;
  busy: CoraMemoryScope | null;
  workspaceAvailable: boolean;
  onToggle: (scope: CoraMemoryScope, enabled: boolean) => void;
  onOpen: (scope: CoraMemoryScope) => void;
  onClear: (scope: CoraMemoryScope, includeUserLines: boolean) => void;
}) {
  const profileName = memory?.profile.name ?? profiles.find((p) => p.id === viewedProfileId)?.name ?? "Cora";
  const globalOff = memory !== null && !memory.global.enabled;
  return (
    <section style={sectionStyle}>
      <div className="agent-capability-list" style={listStyle}>
        {/* Each profile keeps its own two files, so whose memory this is
            comes first, as an ordinary row. */}
        <div style={rowStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={rowNameStyle}>Profile</div>
            <div style={{ ...rowNoteStyle, marginTop: 3 }}>
              Each profile has its own memory. Cora reads it at the start of a chat and adds lessons as it works.
            </div>
          </div>
          <CustomSelect
            ariaLabel="Show the memory of this profile"
            width={200}
            value={viewedProfileId ?? memory?.profile.id ?? "default"}
            disabled={profiles.length === 0 || busy !== null}
            onChange={onViewProfile}
            options={profiles.map((profile) => ({
              value: profile.id,
              label: profile.name,
              ...(profile.isDefault ? { detail: "default" } : {}),
            }))}
          />
        </div>
        {memoryError ? <ErrorRow text={`Could not read memory: ${memoryError}`} onRetry={onRetry} /> : null}
        <MemoryRow
          scope="global"
          title={`Global memory for ${profileName}`}
          detail={`Facts about you and this machine that outlive one repository. This is the master switch: while it is off, Cora reads and writes no memory for ${profileName}, workspace memory included. Profile instructions still apply.`}
          status={memory?.global ?? null}
          busy={busy === "global"}
          unavailable={null}
          onToggle={onToggle}
          onOpen={onOpen}
          onClear={onClear}
        />
        <MemoryRow
          scope="workspace"
          title="Workspace memory"
          detail="Facts about this repository: the command that really runs the tests, a build step with a gotcha, a convention the code does not state."
          status={memory?.workspace ?? null}
          busy={busy === "workspace"}
          unavailable={
            !workspaceAvailable
              ? "No workspace is open."
              : globalOff && memory?.workspace.blockedByGlobal
                ? "Off because Global memory is off. It comes back on with Global memory."
                : globalOff
                  ? "Turn on Global memory first: it is the master switch for this profile."
                  : null
          }
          onToggle={onToggle}
          onOpen={onOpen}
          onClear={onClear}
        />
      </div>
    </section>
  );
}

// One memory tier: what it holds, how full its file is, and the actions on
// it. Content is edited in the editor, which the row opens; the file is
// markdown and a second, worse text box here would compete with it.
function MemoryRow({
  scope,
  title,
  detail,
  status,
  busy,
  unavailable,
  onToggle,
  onOpen,
  onClear,
}: {
  scope: CoraMemoryScope;
  title: string;
  detail: string;
  status: MemoryTierStatus | null;
  busy: boolean;
  /** Why this tier's switch cannot be used right now, or null when it can. */
  unavailable: string | null;
  onToggle: (scope: CoraMemoryScope, enabled: boolean) => void;
  onOpen: (scope: CoraMemoryScope) => void;
  onClear: (scope: CoraMemoryScope, includeUserLines: boolean) => void;
}) {
  const enabled = status?.enabled ?? false;
  const noFile = status === null || !status.path;
  const switchBlocked = unavailable !== null || status === null;
  const lines = status ? status.counts.user + status.counts.cora + status.counts.auto : 0;
  return (
    // Only a tier that cannot be switched dims; an off tier keeps full
    // contrast and its switch says off.
    <div className="agent-capability-row" style={{ ...rowStyle, opacity: switchBlocked ? 0.7 : 1 }}>
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title={title}>
          {title}
        </div>
        <div style={{ ...rowNoteStyle, marginTop: 3 }}>{detail}</div>
        {status && status.path ? (
          <div style={rowMetaStyle}>
            <MemoryPath path={status.path} />
          </div>
        ) : null}
        <div style={rowMetaStyle}>
          {unavailable ? (
            <span style={{ ...memoryNoteStyle, color: "var(--warn)" }}>{unavailable}</span>
          ) : status === null ? (
            <span style={memoryNoteStyle} role="status">Reading the file</span>
          ) : status.bytesUsed === 0 || lines === 0 ? (
            <span style={memoryNoteStyle}>
              Nothing remembered yet. Open it to tell Cora about {scope === "global" ? "yourself" : "this repository"}.
            </span>
          ) : (
            <MemoryMeter status={status} lines={lines} />
          )}
        </div>
      </div>
      <div style={memoryControlsStyle}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <Switch
            checked={enabled}
            disabled={switchBlocked || busy}
            onChange={(next) => onToggle(scope, next)}
            ariaLabel={`${title}: let Cora read and write it`}
            title={unavailable ?? `Load ${title.toLowerCase()} into Cora's chats and let it write there`}
          />
        </div>
        <button
          type="button"
          className="spark-btn"
          style={smallBtnStyle}
          disabled={noFile}
          onClick={() => onOpen(scope)}
          title={status?.path || "Open a workspace first"}
          aria-label={`Open ${title.toLowerCase()} in the editor`}
        >
          Open in editor
        </button>
        <MemoryClearControl
          busy={busy}
          disabled={noFile || lines === 0}
          userLineCount={status?.counts.user ?? 0}
          title={title}
          onClear={(includeUserLines) => onClear(scope, includeUserLines)}
        />
      </div>
    </div>
  );
}

// The folder part gives way first so a narrow pane still shows which file
// this is; the full path stays in the tooltip.
function MemoryPath({ path }: { path: string }) {
  const short = shortPath(path);
  const cut = Math.max(short.lastIndexOf("/"), short.lastIndexOf("\\")) + 1;
  return (
    <span style={memoryPathStyle} title={path}>
      <span style={{ ...memoryPathPartStyle, flex: "0 1 auto", minWidth: 0 }}>{short.slice(0, cut)}</span>
      <span style={{ ...memoryPathPartStyle, flex: "0 0 auto" }}>{short.slice(cut)}</span>
    </span>
  );
}

// How full the file is, in the two units that matter: a bar against the hard
// cap, and the line provenance underneath. The warning tint arrives at the same
// 80% soft cap the writer uses to start asking Cora to consolidate, so the UI
// turns amber on exactly the runs where the tool starts pushing back.
function MemoryMeter({ status, lines }: { status: MemoryTierStatus; lines: number }) {
  const tone = memoryTone(status);
  const color = tone === "over" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  const filled = status.bytesCap > 0 ? Math.min(1, status.bytesUsed / status.bytesCap) : 0;
  return (
    <div style={memoryMeterStyle}>
      <div style={memoryTrackStyle}>
        <div style={{ ...memoryFillStyle, width: `${Math.round(filled * 100)}%`, background: color }} />
      </div>
      <span style={{ ...memoryNoteStyle, color: tone === "ok" ? "var(--muted)" : color }}>
        {formatMemoryBytes(status.bytesUsed)} of {formatMemoryBytes(status.bytesCap)}
        {tone === "over" ? " · full, Cora must consolidate before it can add more" : ""}
        {tone === "warn" ? " · nearly full" : ""}
      </span>
      <span style={memoryNoteStyle}>
        {lines} {lines === 1 ? "line" : "lines"}
        {status.counts.user > 0 ? ` · ${status.counts.user} yours` : ""}
      </span>
    </div>
  );
}

// Clearing is two steps because it deletes a file the user may have written in
// by hand. The default drops only the agent-written lines; taking the user's
// own notes too is a separate, explicit tick.
function MemoryClearControl({
  busy,
  disabled,
  userLineCount,
  title,
  onClear,
}: {
  busy: boolean;
  disabled: boolean;
  userLineCount: number;
  title: string;
  onClear: (includeUserLines: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [includeUserLines, setIncludeUserLines] = useState(false);

  const close = () => {
    setOpen(false);
    setIncludeUserLines(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        className="spark-btn"
        style={smallBtnStyle}
        disabled={busy || disabled}
        onClick={() => setOpen(true)}
        title="Delete what Cora remembered here"
        aria-label={`Clear ${title.toLowerCase()}`}
      >
        {busy ? "Working" : "Clear"}
      </button>
    );
  }

  return (
    <div style={removeChoiceStyle}>
      <span style={cellLabelStyle}>Clear memory</span>
      {userLineCount > 0 ? (
        <label style={{ ...memoryCheckStyle, color: includeUserLines ? "var(--danger)" : "var(--muted)" }}>
          <input
            type="checkbox"
            checked={includeUserLines}
            onChange={(event) => setIncludeUserLines(event.currentTarget.checked)}
          />
          <span>
            Also delete my own notes ({userLineCount} {userLineCount === 1 ? "line" : "lines"})
          </span>
        </label>
      ) : null}
      <div style={removeChoiceRowStyle}>
        <button
          type="button"
          className="spark-btn is-danger"
          style={microBtnStyle}
          onClick={() => {
            close();
            onClear(includeUserLines);
          }}
          title={
            includeUserLines
              ? "Delete every line in this file"
              : "Delete the lines Cora wrote and keep yours"
          }
        >
          {includeUserLines ? "Delete all" : "Clear Cora's lines"}
        </button>
        <button type="button" className="spark-btn" style={microBtnStyle} onClick={close}>
          Keep
        </button>
      </div>
    </div>
  );
}

const memoryPathStyle: React.CSSProperties = {
  display: "flex",
  minWidth: 0,
  maxWidth: "100%",
};

// One line: the folder ellipsizes while the file name stays whole.
const memoryPathPartStyle: React.CSSProperties = {
  overflow: "hidden",
  color: "var(--st-faint)",
  fontSize: 12,
  lineHeight: 1.45,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const memoryControlsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  gap: 10,
};

const removeChoiceStyle: React.CSSProperties = {
  display: "grid",
  justifyItems: "end",
  gap: 4,
};

const removeChoiceRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  gap: 4,
};

const memoryMeterStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  minWidth: 0,
  width: "100%",
};

const memoryTrackStyle: React.CSSProperties = {
  flex: "0 0 120px",
  height: 4,
  borderRadius: 999,
  overflow: "hidden",
  background: "color-mix(in oklab, var(--ink) 8%, transparent)",
};

const memoryFillStyle: React.CSSProperties = {
  height: "100%",
  borderRadius: 999,
  transition: "width var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
};

const memoryNoteStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 12,
  lineHeight: 1.45,
};

const memoryCheckStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  fontSize: 10,
  lineHeight: 1.4,
  maxWidth: 220,
  textAlign: "left",
};
