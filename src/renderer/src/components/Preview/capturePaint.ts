import "./capturePaint.css";

const leases = new WeakMap<HTMLElement, number>();

// Chromium needs visible ancestors to compose a guest. Opacity hides the
// host while it paints without changing React's visibility or tab selection.
function acquire(element: HTMLElement): HTMLElement[] {
  const changed: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const count = leases.get(node) ?? 0;
    if (count || getComputedStyle(node).visibility === "hidden") {
      leases.set(node, count + 1);
      node.setAttribute("data-preview-capture-paint", "");
      changed.push(node);
    }
  }
  return changed;
}

function release(changed: HTMLElement[]): void {
  for (const node of changed) {
    const count = (leases.get(node) ?? 1) - 1;
    if (count) leases.set(node, count);
    else {
      leases.delete(node);
      node.removeAttribute("data-preview-capture-paint");
    }
  }
}

export async function withPreviewCapturePaint<T>(element: HTMLElement, capture: () => Promise<T>): Promise<T> {
  const changed = acquire(element);
  try {
    if (changed.length) {
      element.getBoundingClientRect();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return await capture();
  } finally {
    release(changed);
  }
}

/**
 * Keep a hidden guest painting until the returned release runs, so a
 * recording of a background tab keeps receiving frames.
 */
export function holdPreviewCapturePaint(element: HTMLElement): () => void {
  const changed = acquire(element);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release(changed);
  };
}
