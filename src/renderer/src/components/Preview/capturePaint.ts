import "./capturePaint.css";

const leases = new WeakMap<HTMLElement, number>();
// Tab order the frames inside a leased guest had before the lease.
const untabbed = new WeakMap<HTMLElement, Array<[Element, string | null]>>();

/**
 * The webview's own frame sits in its shadow root, out of reach of the CSS
 * that hides the rest, and stays in the Tab order: a revealed but invisible
 * guest would take the user's focus and typing. A negative tabindex on the
 * frame skips the guest's content; agents' input goes to the guest directly
 * and is unaffected.
 */
function keepOutOfTabOrder(element: HTMLElement): void {
  const frames = Array.from(element.shadowRoot?.querySelectorAll("iframe") ?? []);
  if (!frames.length) return;
  untabbed.set(element, frames.map((frame) => [frame, frame.getAttribute("tabindex")]));
  for (const frame of frames) frame.setAttribute("tabindex", "-1");
}

function restoreTabOrder(element: HTMLElement): void {
  for (const [frame, tabindex] of untabbed.get(element) ?? []) {
    if (tabindex === null) frame.removeAttribute("tabindex");
    else frame.setAttribute("tabindex", tabindex);
  }
  untabbed.delete(element);
}

/**
 * Let a background guest render until the returned release runs. Chromium
 * needs visible ancestors to compose a guest; opacity hides the host
 * meanwhile without changing React's visibility or tab selection.
 */
export function holdPreviewCapturePaint(element: HTMLElement): { changed: boolean; release: () => void } {
  const changed: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const count = leases.get(node) ?? 0;
    if (count || getComputedStyle(node).visibility === "hidden") {
      leases.set(node, count + 1);
      node.setAttribute("data-preview-capture-paint", "");
      changed.push(node);
    }
  }
  if (changed[0] === element && leases.get(element) === 1) keepOutOfTabOrder(element);
  let released = false;
  return {
    changed: changed.length > 0,
    release: () => {
      if (released) return;
      released = true;
      for (const node of changed) {
        const count = (leases.get(node) ?? 1) - 1;
        if (count) leases.set(node, count);
        else {
          leases.delete(node);
          node.removeAttribute("data-preview-capture-paint");
          if (node === element) restoreTabOrder(element);
        }
      }
    },
  };
}

export async function withPreviewCapturePaint<T>(element: HTMLElement, capture: () => Promise<T>): Promise<T> {
  const hold = holdPreviewCapturePaint(element);
  try {
    if (hold.changed) {
      element.getBoundingClientRect();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return await capture();
  } finally {
    hold.release();
  }
}

const FRAME_TIMEOUT_MS = 4_000;
const TIMED_OUT = "capture timed out";

/**
 * One frame of the guest as a PNG data URL. A background tab can miss a
 * frame while its paint is held, and can hand back an empty one: each gets
 * one more try before the call fails with what to do next.
 */
export async function captureFrameDataUrl(
  capture: () => Promise<{ getSize?: () => { width: number; height: number }; toDataURL?: () => string } | undefined>,
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let img;
    try {
      img = await Promise.race([
        capture(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(TIMED_OUT)), timeoutMs);
        }),
      ]);
    } catch (err) {
      const timedOut = (err as Error)?.message === TIMED_OUT;
      if (timedOut && attempt === 0) continue;
      throw new Error(
        timedOut
          ? `The tab did not paint a frame within ${Math.round((2 * timeoutMs) / 1000)} s (it is in the background or busy). Call codara_preview_screenshot once more, or read the page with codara_preview_snapshot, which needs no paint.`
          : `preview screenshot failed: ${(err as Error)?.message || String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const size = img?.getSize?.();
    const dataUrl = size?.width && size?.height ? img?.toDataURL?.() : "";
    if (dataUrl && dataUrl.length > 256) return dataUrl;
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("preview screenshot unavailable: the browser returned an empty frame. Check navigation with codara_preview_snapshot before retrying.");
}
