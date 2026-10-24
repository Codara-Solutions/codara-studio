// Which agent is driving each browser tab, where its cursor goes next, and
// which agents the user stopped. previewRpc.ts writes here as agent calls
// arrive; the AgentPresence overlay of the tab's pane reads it and animates.
// Kept apart from the pane so the toolbar can move without touching it.

import type { Point } from "./glide";

export interface Driver {
  key: string;
  name: string;
  runtime: string | null;
  workspace: string | null;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CursorMove {
  action: string;
  point?: Point;
  /** The field being typed into, highlighted while the cursor sits on it. */
  box?: Box;
  press?: boolean;
  /** Move at once, without a glide (the steps of a drag). */
  follow?: boolean;
}

export interface PresenceState {
  driver: Driver | null;
  action: string | null;
  /** When the driver last acted; the banner fades a few seconds after. */
  activeAt: number;
  /** The driver the user just stopped, for the notice that offers Undo. */
  stopped: Driver | null;
  stoppedAt: number;
}

type Animator = (move: CursorMove) => Promise<void>;

/** An action never waits longer than this for its cursor to arrive. */
export const GLIDE_WAIT_CAP_MS = 600;

const EMPTY: PresenceState = { driver: null, action: null, activeAt: 0, stopped: null, stoppedAt: 0 };
const states = new Map<string, PresenceState>();
const listeners = new Map<string, Set<() => void>>();
const animators = new Map<string, Animator>();
const stoppedKeys = new Map<string, Map<string, Driver>>();

export class StoppedDriverError extends Error {}

export function readDriver(value: unknown): Driver | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || !record.key) return null;
  return {
    key: record.key,
    name: typeof record.name === "string" && record.name ? record.name : "An agent",
    runtime: typeof record.runtime === "string" && record.runtime ? record.runtime : null,
    workspace: typeof record.workspace === "string" && record.workspace ? record.workspace : null,
  };
}

export function presenceState(tabId: string): PresenceState {
  return states.get(tabId) ?? EMPTY;
}

export function subscribePresence(tabId: string, listener: () => void): () => void {
  let set = listeners.get(tabId);
  if (!set) listeners.set(tabId, (set = new Set()));
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && !set.size) listeners.delete(tabId);
  };
}

function update(tabId: string, next: PresenceState): void {
  states.set(tabId, next);
  for (const listener of listeners.get(tabId) ?? []) listener();
}

export function isDriverStopped(tabId: string, key: string): boolean {
  return stoppedKeys.get(tabId)?.has(key) === true;
}

/** Throws the message the agent reads when the user took this tab back from it. */
export function assertDriverAllowed(tabId: string, driver: Driver | null): void {
  if (!driver || !isDriverStopped(tabId, driver.key)) return;
  throw new StoppedDriverError(
    `The user stopped ${driver.name} from using browser tab ${tabId} and took it back. ` +
    "Do not use this tab again or retry the call; ask the user if you still need it.",
  );
}

/** An agent call reached the tab: the banner names its driver. */
export function noteDriving(tabId: string, driver: Driver | null, action?: string): void {
  if (!driver) return;
  const previous = presenceState(tabId);
  update(tabId, { ...previous, driver, action: action ?? previous.action ?? "Working", activeAt: Date.now() });
}

/** Resolves once the cursor reached the move's point, or at once when no pane draws it. */
export async function moveAgentCursor(tabId: string, driver: Driver | null, move: CursorMove): Promise<void> {
  if (!driver) return;
  noteDriving(tabId, driver, move.action);
  const animate = animators.get(tabId);
  if (!animate || !move.point) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    animate(move).catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, GLIDE_WAIT_CAP_MS);
    }),
  ]);
  clearTimeout(timer);
}

export function registerCursorAnimator(tabId: string, animate: Animator): () => void {
  animators.set(tabId, animate);
  return () => {
    if (animators.get(tabId) === animate) animators.delete(tabId);
  };
}

/**
 * The user's Stop: this driver's calls on this tab are refused from now on.
 * The banner passes the driver it shows; without one, whoever drives now.
 */
export function stopDriver(tabId: string, which?: Driver): Driver | null {
  const state = presenceState(tabId);
  const driver = which ?? state.driver;
  if (!driver) return null;
  let keys = stoppedKeys.get(tabId);
  if (!keys) stoppedKeys.set(tabId, (keys = new Map()));
  keys.set(driver.key, driver);
  update(tabId, { ...state, driver: state.driver?.key === driver.key ? null : state.driver, stopped: driver, stoppedAt: Date.now() });
  return driver;
}

/** Undo a Stop. */
export function allowDriver(tabId: string, key: string): void {
  const keys = stoppedKeys.get(tabId);
  keys?.delete(key);
  if (keys && !keys.size) stoppedKeys.delete(tabId);
  const state = presenceState(tabId);
  if (state.stopped?.key === key) update(tabId, { ...state, stopped: null, stoppedAt: 0 });
}

/** The banner's notice about a stop has been read or timed out. */
export function dismissStopNotice(tabId: string): void {
  const state = presenceState(tabId);
  if (state.stopped) update(tabId, { ...state, stopped: null, stoppedAt: 0 });
}

/** A run ended: its tabs stop showing it as driving. */
export function clearDriver(key: string): void {
  for (const [tabId, state] of states) {
    if (state.driver?.key === key) update(tabId, { ...state, driver: null, action: null });
  }
}

/** The tab closed: forget its stops along with everything else. */
export function forgetPresenceTab(tabId: string): void {
  stoppedKeys.delete(tabId);
  animators.delete(tabId);
  if (states.has(tabId)) update(tabId, EMPTY);
  states.delete(tabId);
}
