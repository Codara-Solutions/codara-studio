import "./capturePaint.css";

const leases = new WeakMap<HTMLElement, number>();

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
