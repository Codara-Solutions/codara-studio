import { useEffect, useState, type RefObject } from "react";

// react-virtuoso hides its item list after jumping to initialTopMostItemIndex
// until the list has gone 150 ms without changing (a fixed timer in its
// scrollToIndex), although the rows are in place several frames earlier. On
// a long chat that leaves the conversation blank for about nine frames after
// it is ready. The list is shown once it has jumped away from the top and
// then held its scroll position, height and rendered rows for three frames:
// the same picture Virtuoso reveals later, only sooner. Until a jump is seen
// (the rows painted first can be ones from the top), Virtuoso decides alone.
// Rows still loading content that changes their height (an image, a Mermaid
// diagram) keep the list hidden too, since Virtuoso would re-scroll when it
// lands.

export interface ListSample {
  scrollTop: number;
  scrollHeight: number;
  rows: string;
  pending: boolean;
}

export interface RevealState {
  jumped: boolean;
  last: ListSample | null;
  still: number;
}

export const STILL_FRAMES_TO_REVEAL = 3;
const MAX_FRAMES = 120;

export function nextRevealState(state: RevealState, sample: ListSample | null): RevealState {
  if (!sample || sample.rows === "") return { ...state, last: null, still: 0 };
  const jumped = state.jumped || sample.scrollTop > 0;
  const same =
    state.last !== null &&
    !state.last.pending &&
    state.last.scrollTop === sample.scrollTop &&
    state.last.scrollHeight === sample.scrollHeight &&
    state.last.rows === sample.rows;
  return { jumped, last: sample, still: jumped && same && !sample.pending ? state.still + 1 : 0 };
}

export function shouldReveal(state: RevealState): boolean {
  return state.jumped && state.still >= STILL_FRAMES_TO_REVEAL - 1;
}

function sampleList(root: HTMLElement): { sample: ListSample | null; hidden: boolean } {
  const scroller = root.querySelector<HTMLElement>(":scope > [data-virtuoso-scroller]");
  const list = scroller?.querySelector<HTMLElement>(':scope > [data-viewport-type] > [data-testid="virtuoso-item-list"]');
  if (!scroller || !list) return { sample: null, hidden: true };
  const first = list.firstElementChild?.getAttribute("data-index") ?? "";
  const last = list.lastElementChild?.getAttribute("data-index") ?? "";
  const pending =
    list.querySelector("[data-mermaid-pending]") !== null ||
    Array.from(list.querySelectorAll("img")).some((image) => !image.complete);
  return {
    sample: { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, rows: first && `${first}-${last}`, pending },
    hidden: list.style.visibility === "hidden",
  };
}

// Returns true once the list mounted under `key` may be shown. The caller
// marks its container so styles.css overrides Virtuoso's inline visibility.
export function useEarlyListReveal(rootRef: RefObject<HTMLElement>, key: string, enabled: boolean): boolean {
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    let state: RevealState = { jumped: false, last: null, still: 0 };
    let frames = 0;
    let handle = 0;
    const tick = () => {
      frames += 1;
      const { sample, hidden } = sampleList(root);
      if (sample && !hidden) return;
      state = nextRevealState(state, sample);
      if (shouldReveal(state)) {
        setRevealedKey(key);
        return;
      }
      if (frames < MAX_FRAMES) handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(handle);
      // A later list under the same key (a chat that empties and fills
      // again) is a new Virtuoso and must not inherit this reveal.
      setRevealedKey((current) => (current === key ? null : current));
    };
  }, [rootRef, key, enabled]);
  return revealedKey === key;
}
