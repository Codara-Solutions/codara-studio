// JavaScript dialogs (alert, confirm, prompt, beforeunload) of one tab.
//
// A dialog blocks its page until someone answers it, which used to stall an
// agent's session with nothing telling it why. Every open dialog is tracked
// here per tab session, whoever answers it: the agent (codara_preview_dialog),
// the user (the bar the browser pane shows), or the tab's policy. Tool calls
// report open dialogs and the ones answered for them (dialog-guard.ts).
//
// Two sources feed it:
// - "protocol": Page.javascriptDialogOpening on the tab's DevTools session,
//   answered with Page.handleJavaScriptDialog. A Chrome tab's dialogs and a
//   Codara tab's subframe dialogs arrive this way.
// - "page": a Codara tab's main frame, whose preload hands alert/confirm/
//   prompt to main (preview-dialogs.ts) so no native message box opens.

import type { CdpSession } from "../cdp-session";

export type PageDialogType = "alert" | "confirm" | "prompt" | "beforeunload";
export type DialogPolicyAction = "ask" | "accept" | "dismiss";

export interface DialogPolicy {
  /** ask: wait for an answer up to autoMs, then dismiss. accept or dismiss: answer at once. */
  action: DialogPolicyAction;
  autoMs: number;
}

export const DEFAULT_DIALOG_POLICY: DialogPolicy = { action: "ask", autoMs: 30_000 };
export const DIALOG_AUTO_MS_MAX = 600_000;

export interface PageDialog {
  id: string;
  type: PageDialogType;
  message: string;
  defaultPrompt: string;
  url: string;
  openedAt: string;
  source: "page" | "protocol";
  /** When the policy answers it if nobody else does. */
  autoAt: string | null;
}

export interface DialogAnswer {
  accept: boolean;
  promptText?: string;
}

export interface DialogOutcome {
  id: string;
  type: PageDialogType;
  message: string;
  accepted: boolean;
  promptText?: string;
  by: "agent" | "user" | "policy";
  at: string;
}

/** How a dialog is shown to the user while it waits; set by the app (preview-dialogs.ts). */
export interface DialogPresenter {
  /** Resolves with the user's answer, or null when the dialog closed some other way. */
  show(session: CdpSession, dialog: PageDialog): Promise<DialogAnswer | null>;
  hide(session: CdpSession, dialog: PageDialog): void;
}

interface OpenDialog {
  dialog: PageDialog;
  respond(answer: DialogAnswer): Promise<void> | void;
  timer: ReturnType<typeof setTimeout> | null;
}

const OUTCOME_CAP = 20;
let presenter: DialogPresenter | null = null;
let nextId = 0;

export function setDialogPresenter(next: DialogPresenter | null): void {
  presenter = next;
}

export class DialogState {
  private readonly open = new Map<string, OpenDialog>();
  private readonly unreported: DialogOutcome[] = [];
  private readonly openListeners = new Set<(dialog: PageDialog) => void>();
  private inFlight = 0;
  policy: DialogPolicy = { ...DEFAULT_DIALOG_POLICY };

  constructor(private readonly session: CdpSession) {}

  pending(): PageDialog[] {
    return [...this.open.values()].map((entry) => entry.dialog);
  }

  /** Outcomes nobody has been told about yet; reading them marks them told. */
  takeUnreported(): DialogOutcome[] {
    return this.unreported.splice(0);
  }

  /** An agent call on this tab is running (beforeunload follows it under the ask policy). */
  get agentCallInFlight(): boolean {
    return this.inFlight > 0;
  }

  callStarted(): () => void {
    this.inFlight += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
    };
  }

  onOpen(listener: (dialog: PageDialog) => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  /** Track a dialog that just opened; respond answers it in the page. */
  add(
    fields: Omit<PageDialog, "id" | "openedAt" | "autoAt">,
    respond: (answer: DialogAnswer) => Promise<void> | void,
  ): PageDialog {
    const policy = this.policy;
    const immediate = policy.action !== "ask";
    const dialog: PageDialog = {
      ...fields,
      id: `dialog-${++nextId}`,
      openedAt: new Date().toISOString(),
      autoAt: immediate ? null : new Date(Date.now() + policy.autoMs).toISOString(),
    };
    const entry: OpenDialog = { dialog, respond, timer: null };
    this.open.set(dialog.id, entry);
    if (immediate) {
      void this.answer(dialog.id, { accept: policy.action === "accept", promptText: fields.defaultPrompt }, "policy");
      return dialog;
    }
    entry.timer = setTimeout(() => {
      void this.answer(dialog.id, { accept: dialog.type === "alert" }, "policy");
    }, policy.autoMs);
    for (const listener of this.openListeners) listener(dialog);
    if (presenter) {
      presenter.show(this.session, dialog).then(
        (answer) => {
          if (answer) void this.answer(dialog.id, answer, "user");
        },
        () => {},
      );
    }
    return dialog;
  }

  /** Answer an open dialog; false when it is no longer open. */
  async answer(id: string, answer: DialogAnswer, by: DialogOutcome["by"]): Promise<boolean> {
    const entry = this.open.get(id);
    if (!entry) return false;
    this.open.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const { dialog } = entry;
    const outcome: DialogOutcome = {
      id,
      type: dialog.type,
      message: dialog.message,
      accepted: answer.accept,
      ...(dialog.type === "prompt" && answer.accept ? { promptText: answer.promptText ?? dialog.defaultPrompt } : {}),
      by,
      at: new Date().toISOString(),
    };
    // The agent that answered learns the outcome from its own call.
    if (by !== "agent") {
      this.unreported.push(outcome);
      if (this.unreported.length > OUTCOME_CAP) this.unreported.shift();
    }
    presenter?.hide(this.session, dialog);
    try {
      await entry.respond({ accept: answer.accept, promptText: outcome.promptText });
    } catch {
      /* the page went away with its dialog */
    }
    return true;
  }

  /** The page answered or dropped the dialog itself (navigation, reload, closed tab). */
  closed(id: string): void {
    const entry = this.open.get(id);
    if (!entry) return;
    this.open.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    presenter?.hide(this.session, entry.dialog);
  }

  /** Record an outcome decided outside this state (beforeunload in a Codara tab). */
  note(outcome: Omit<DialogOutcome, "id" | "at">): void {
    this.unreported.push({ ...outcome, id: `dialog-${++nextId}`, at: new Date().toISOString() });
    if (this.unreported.length > OUTCOME_CAP) this.unreported.shift();
  }

  closeAll(): void {
    for (const id of [...this.open.keys()]) this.closed(id);
  }
}

const states = new WeakMap<CdpSession, DialogState>();

export function dialogState(session: CdpSession): DialogState {
  let state = states.get(session);
  if (!state) states.set(session, (state = new DialogState(session)));
  return state;
}

/** Clamp a policy an agent asked for. */
export function normalizeDialogPolicy(raw: { action?: unknown; autoMs?: unknown }, current: DialogPolicy): DialogPolicy {
  const action = raw.action === "ask" || raw.action === "accept" || raw.action === "dismiss" ? raw.action : current.action;
  const autoMs = typeof raw.autoMs === "number" && Number.isFinite(raw.autoMs)
    ? Math.max(0, Math.min(DIALOG_AUTO_MS_MAX, Math.round(raw.autoMs)))
    : current.autoMs;
  return { action, autoMs };
}

const PROTOCOL_TYPES = new Set<PageDialogType>(["alert", "confirm", "prompt", "beforeunload"]);
const recording = new WeakSet<CdpSession>();

export interface DialogRecorderOptions {
  /**
   * "host": the embedding app decides beforeunload itself (a Codara tab, in
   * preview-dialogs.ts) and the protocol only reports it in passing, so it
   * is not tracked as an open dialog here.
   */
  beforeUnload?: "protocol" | "host";
}

/** Track the dialogs the protocol reports on this session. */
export function startDialogRecorder(session: CdpSession, options: DialogRecorderOptions = {}): void {
  if (recording.has(session)) return;
  recording.add(session);
  const state = dialogState(session);
  let current: string | null = null;
  session.on("Page.javascriptDialogOpening", (params) => {
    if (params.type === "beforeunload" && options.beforeUnload === "host") return;
    const type = PROTOCOL_TYPES.has(params.type as PageDialogType) ? (params.type as PageDialogType) : "alert";
    const dialog = state.add({
      type,
      message: typeof params.message === "string" ? params.message : "",
      defaultPrompt: typeof params.defaultPrompt === "string" ? params.defaultPrompt : "",
      url: typeof params.url === "string" ? params.url : "",
      source: "protocol",
    }, async (answer) => {
      await session.send("Page.handleJavaScriptDialog", {
        accept: answer.accept,
        ...(answer.promptText !== undefined ? { promptText: answer.promptText } : {}),
      });
    });
    current = dialog.id;
  });
  session.on("Page.javascriptDialogClosed", () => {
    if (current) state.closed(current);
    current = null;
  });
  session.onDetach(() => {
    if (current) state.closed(current);
    current = null;
  });
  session.hold("Page");
}

/** The compact form tool results carry. */
export function describeDialog(dialog: PageDialog): Record<string, unknown> {
  return {
    id: dialog.id,
    type: dialog.type,
    message: dialog.message.length > 300 ? `${dialog.message.slice(0, 300)}...` : dialog.message,
    ...(dialog.type === "prompt" ? { defaultPrompt: dialog.defaultPrompt } : {}),
    ...(dialog.autoAt ? { autoDismissAt: dialog.autoAt } : {}),
  };
}
