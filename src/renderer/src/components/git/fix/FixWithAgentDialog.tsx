import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GitFixAgentsAvailable, GitFixKind, GitFixRequest } from "@shared/git-fix";
import { emitLocalToast } from "../../../notifications/local-toast";
import { useOptionalSelectionRouting } from "../../../routing/SelectionRoutingContext";
import { MOD_KEY, fmtShortcut } from "../../../shortcuts/platform";
import { Spinner } from "../git-ui";
import { deliverToNewAgent, fixAgentHost } from "./agent-launcher";
import {
  FIX_TARGET_GROUP_TITLES,
  FIX_TARGET_STORAGE_KEY,
  defaultFixTarget,
  fixAgentName,
  fixPromptWithNote,
  fixTargets,
  parseRememberedFixTarget,
  rememberedFixTarget,
  type FixTarget,
  type RememberedFixTarget,
} from "./fix-targets";

// "Fix with agent": shows what Codara read about the problem, lets the user
// pick who fixes it, and sends the prompt through main's delivery service
// (agent-delivery.ts), a new Cora chat, or a new agent CLI that receives it
// once it is ready. Nothing is sent until the user presses Send.

interface Props {
  cwd: string;
  kind: GitFixKind;
  output?: string;
  commitMessage?: string;
  onClose: () => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; request: GitFixRequest };

const LOADING_TEXT: Record<GitFixKind, string> = {
  checks: "Reading the failing checks and their logs…",
  hook: "Reading what the commit hook reported…",
  conflicts: "Reading the conflicted files…",
  review: "Reading the unresolved review threads…",
};

function readRemembered(): RememberedFixTarget | null {
  try {
    return parseRememberedFixTarget(window.localStorage.getItem(FIX_TARGET_STORAGE_KEY));
  } catch {
    return null;
  }
}

function remember(target: FixTarget): void {
  try {
    window.localStorage.setItem(FIX_TARGET_STORAGE_KEY, rememberedFixTarget(target));
  } catch {
    // Storage can be unavailable; the default pick still works.
  }
}

function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  // IPC wraps main's errors; the user needs only the reason.
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || "Something went wrong. Try again.";
}

// Runs after the dialog closes: the new agent can take a while to start.
function sendToNewAgent(target: FixTarget, cwd: string, workspaceId: string, text: string): boolean {
  const host = fixAgentHost();
  if (!host || !target.runtime) return false;
  const name = fixAgentName(target.runtime);
  void deliverToNewAgent(
    {
      launch: (runtime, at) => host.launch(runtime, at),
      ready: {
        onState: (handler) => window.spark.terminalNotify.onState(handler),
        snapshot: () => window.spark.terminalNotify.snapshot(),
        paneState: (tabId) => host.paneState(tabId),
      },
      deliver: (request) => window.spark.agentDelivery.deliver(request),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    { runtime: target.runtime, cwd, workspaceId, text },
  ).then(
    (outcome) => {
      if (outcome.kind === "sent") emitLocalToast(`Sent to the new ${name}`, "It has the problem and is working on it.");
      else if (outcome.reason === "exited") {
        emitLocalToast(`${name} stopped before it could start`, "The fix is waiting in the agent inbox for any agent in this workspace.", "warning");
      } else {
        emitLocalToast(`${name} is still starting`, "The fix is waiting in its inbox. Ask it to check its Codara inbox when it is ready.", "warning");
      }
    },
    (cause) => emitLocalToast(`Could not send to ${name}`, errorText(cause), "danger"),
  );
  return true;
}

export default function FixWithAgentDialog({ cwd, kind, output, commitMessage, onClose }: Props): React.ReactElement {
  const routing = useOptionalSelectionRouting();
  const titleId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [agents, setAgents] = useState<GitFixAgentsAvailable | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.spark.gitFix.prepare({ cwd, kind, ...(output ? { output } : {}), ...(commitMessage ? { commitMessage } : {}) }).then(
      (result) => {
        if (cancelled) return;
        setPhase(result.ok ? { kind: "ready", request: result.request } : { kind: "error", message: result.error });
      },
      (cause) => {
        if (!cancelled) setPhase({ kind: "error", message: errorText(cause) });
      },
    );
    window.spark.gitFix.agents().then(
      (found) => {
        if (!cancelled) setAgents(found);
      },
      () => {
        if (!cancelled) setAgents({ claude: false, codex: false, grok: false, pi: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cwd, kind, output, commitMessage]);

  // Read once per open: panes and chats as they are now.
  const routingDestinations = useMemo(() => routing?.destinationsFor(null) ?? null, [routing]);
  const targets = useMemo(
    () => (routingDestinations ? fixTargets(routingDestinations.destinations, agents) : []),
    [agents, routingDestinations],
  );
  const remembered = useMemo(readRemembered, []);
  const selectedId =
    targets.find((target) => target.id === chosenId && !target.disabled)?.id ??
    defaultFixTarget(targets, remembered, routingDestinations?.defaultId ?? null);
  const selected = targets.find((target) => target.id === selectedId) ?? null;

  const ready = phase.kind === "ready";
  const promptText = ready ? fixPromptWithNote(phase.request.prompt, note) : "";

  useEffect(() => {
    if (ready) sendButtonRef.current?.focus();
    else dialogRef.current?.focus();
  }, [ready]);

  const send = useCallback(async () => {
    if (phase.kind !== "ready" || !selected || sending) return;
    const workspaceId = routing?.workspaceId;
    if (!routing || !workspaceId) {
      setSendError("Open a workspace first.");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const text = fixPromptWithNote(phase.request.prompt, note);
      if (selected.kind === "agent-new") {
        if (!sendToNewAgent(selected, cwd, workspaceId, text)) {
          throw new Error("Codara cannot open a new agent here. Pick another target.");
        }
        remember(selected);
        emitLocalToast(`Starting ${selected.runtime ? fixAgentName(selected.runtime) : "the agent"}`, "The fix goes in as soon as it is ready.");
        onClose();
        return;
      }
      if (selected.kind === "chat-new") {
        await routing.route({ source: "git", text }, "chat-new");
        remember(selected);
        emitLocalToast("Started a Cora chat", phase.request.title);
        onClose();
        return;
      }
      const target =
        selected.kind === "pane" && selected.paneId
          ? { kind: "pane" as const, paneId: selected.paneId }
          : selected.kind === "chat" && selected.runId
            ? { kind: "chat" as const, runId: selected.runId }
            : { kind: "inbox" as const, paneId: null };
      const result = await window.spark.agentDelivery.deliver({
        workspaceId,
        target,
        text,
        submit: target.kind === "pane",
        source: "git",
      });
      remember(selected);
      emitLocalToast(
        result.outcome === "queued" ? "Waiting in the agent inbox" : `Sent to ${selected.label}`,
        result.outcome === "queued" ? "Any agent in this workspace can pull it." : phase.request.title,
      );
      onClose();
    } catch (cause) {
      setSendError(errorText(cause));
    } finally {
      setSending(false);
    }
  }, [cwd, note, onClose, phase, routing, selected, sending]);

  const copy = useCallback(() => {
    if (!promptText) return;
    void window.spark.clipboard.writeText(promptText).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
      },
      () => setSendError("Could not copy the prompt."),
    );
  }, [promptText]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void send();
      } else if (event.key === "Tab") {
        // Keep focus inside the dialog.
        const root = dialogRef.current;
        if (!root) return;
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"),
        ).filter((element) => element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, send, sending]);

  const groups = useMemo(() => {
    const out: Array<{ group: FixTarget["group"]; items: FixTarget[] }> = [];
    for (const target of targets) {
      const last = out[out.length - 1];
      if (last && last.group === target.group) last.items.push(target);
      else out.push({ group: target.group, items: [target] });
    }
    return out;
  }, [targets]);

  const title = phase.kind === "ready" ? phase.request.title : "Fix with agent";

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--modal-scrim)",
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !sending) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="spark-glass--strong spark-overlay-surface"
        data-git-fix-dialog={kind}
        style={{
          width: 600,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
          display: "flex",
          flexDirection: "column",
          borderRadius: 14,
          overflow: "hidden",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid var(--rule-soft)",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              id={titleId}
              style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {title}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 1 }}>
              Nothing is sent until you press Send.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            disabled={sending}
            style={{
              appearance: "none",
              border: "none",
              background: "transparent",
              color: "var(--muted)",
              fontSize: 15,
              cursor: "default",
              padding: 4,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          {phase.kind === "loading" ? (
            <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12, padding: "18px 0" }}>
              <Spinner size={13} />
              <span>{LOADING_TEXT[kind]}</span>
            </div>
          ) : phase.kind === "error" ? (
            <div
              role="alert"
              style={{
                padding: "9px 11px",
                borderRadius: 8,
                border: "1px solid color-mix(in oklch, var(--danger) 42%, var(--rule-soft))",
                background: "var(--danger-soft)",
                color: "color-mix(in oklch, var(--danger) 80%, var(--ink))",
                fontSize: 11.5,
                lineHeight: 1.5,
              }}
            >
              {phase.message}
            </div>
          ) : (
            <>
              <section aria-label="What the agent receives">
                <SectionLabel>What the agent receives</SectionLabel>
                <ul style={{ margin: "6px 0 0", padding: "0 0 0 16px", display: "flex", flexDirection: "column", gap: 3 }}>
                  {phase.request.summary.map((line, index) => (
                    <li key={index} style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--ink-dim)", wordBreak: "break-word" }}>
                      {line}
                    </li>
                  ))}
                </ul>
              </section>

              <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
                <legend style={{ padding: 0 }}>
                  <SectionLabel>Send to</SectionLabel>
                </legend>
                {!routing ? (
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>Open a workspace first.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
                    {groups.map(({ group, items }) => (
                      <div key={group} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--muted-2)", padding: "0 2px 2px" }}>
                          {FIX_TARGET_GROUP_TITLES[group]}
                        </div>
                        {items.map((target) => (
                          <TargetOption
                            key={target.id}
                            target={target}
                            checked={target.id === selectedId}
                            disabled={sending || Boolean(target.disabled)}
                            onChoose={() => setChosenId(target.id)}
                          />
                        ))}
                      </div>
                    ))}
                    {agents === null ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--muted)" }}>
                        <Spinner size={10} />
                        Looking for agent CLIs you can start…
                      </div>
                    ) : null}
                  </div>
                )}
              </fieldset>

              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <SectionLabel>Your note (optional)</SectionLabel>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  disabled={sending}
                  rows={2}
                  maxLength={2_000}
                  placeholder="Anything the agent should know first"
                  style={{
                    resize: "vertical",
                    minHeight: 40,
                    padding: "7px 9px",
                    borderRadius: 7,
                    border: "1px solid var(--rule)",
                    background: "var(--bg)",
                    color: "var(--ink)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 11.5,
                    lineHeight: 1.45,
                  }}
                />
              </label>

              <details>
                <summary style={{ cursor: "default", fontSize: 11, fontWeight: 650, color: "var(--ink-dim)" }}>
                  Show the full prompt ({promptText.length.toLocaleString()} characters)
                </summary>
                <pre
                  data-git-fix-prompt
                  tabIndex={0}
                  style={{
                    margin: "8px 0 0",
                    maxHeight: 260,
                    overflow: "auto",
                    padding: "9px 11px",
                    borderRadius: 8,
                    border: "1px solid var(--rule-soft)",
                    background: "var(--bg)",
                    color: "var(--ink-dim)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {promptText}
                </pre>
              </details>
            </>
          )}
          {sendError ? (
            <div role="alert" style={{ fontSize: 11, lineHeight: 1.45, color: "var(--danger)" }}>
              {sendError}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 18px",
            borderTop: "1px solid var(--rule-soft)",
            background: "color-mix(in oklab, var(--bg) 40%, transparent)",
          }}
        >
          {ready ? (
            <FooterButton label={copied ? "Copied" : "Copy prompt"} onClick={copy} disabled={sending} />
          ) : null}
          <span style={{ flex: 1 }} />
          <FooterButton label="Cancel" onClick={onClose} disabled={sending} />
          <FooterButton
            buttonRef={sendButtonRef}
            label={sending ? "Sending…" : "Send"}
            title={`Send (${fmtShortcut(MOD_KEY, "Enter")})`}
            primary
            disabled={!ready || !selected || !routing || sending}
            onClick={() => void send()}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink)" }}>{children}</span>;
}

function TargetOption({
  target,
  checked,
  disabled,
  onChoose,
}: {
  target: FixTarget;
  checked: boolean;
  disabled: boolean;
  onChoose: () => void;
}): React.ReactElement {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        borderRadius: 7,
        border: checked ? "1px solid var(--accent-edge)" : "1px solid transparent",
        background: checked ? "var(--accent-soft)" : "transparent",
        opacity: disabled && !checked ? 0.6 : 1,
        cursor: "default",
      }}
    >
      <input
        type="radio"
        name="git-fix-target"
        value={target.id}
        checked={checked}
        disabled={disabled}
        onChange={onChoose}
        // Drawn with theme tokens: the native control follows the window's
        // color scheme, not the light or dark theme.
        style={{
          appearance: "none",
          flex: "0 0 auto",
          width: 13,
          height: 13,
          margin: 0,
          borderRadius: "50%",
          border: checked ? "1.5px solid var(--accent)" : "1.5px solid var(--rule-strong)",
          background: checked ? "radial-gradient(circle, var(--accent) 0 3px, transparent 3.5px)" : "transparent",
          cursor: "default",
        }}
      />
      <span style={{ minWidth: 0, fontSize: 11.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {target.label}
      </span>
      {target.sublabel ? (
        <span style={{ flex: "0 0 auto", fontSize: 10, color: "var(--muted)" }}>{target.sublabel}</span>
      ) : null}
    </label>
  );
}

function FooterButton({
  label,
  title,
  onClick,
  disabled,
  primary,
  buttonRef,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled: boolean;
  primary?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <button
      ref={buttonRef}
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 29,
        padding: "0 14px",
        borderRadius: 8,
        cursor: "default",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 700,
        border: primary ? "1px solid var(--accent-edge)" : "1px solid var(--rule)",
        background:
          primary && !disabled
            ? hover
              ? "color-mix(in oklch, var(--accent) 24%, transparent)"
              : "var(--accent-soft)"
            : hover && !disabled
              ? "var(--hover)"
              : "transparent",
        color: disabled ? "var(--muted-2)" : primary ? "var(--ink)" : "var(--ink-dim)",
        opacity: disabled ? 0.7 : 1,
        transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}
