import "./capturePaint.css";

const leases = new WeakMap<HTMLElement, number>();

export async function withPreviewCapturePaint<T>(element: HTMLElement, capture: () => Promise<T>): Promise<T> {
  const changed: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const count = leases.get(node) ?? 0;
    if (count || getComputedStyle(node).visibility === "hidden") {
      leases.set(node, count + 1);
      node.setAttribute("data-preview-capture-paint", "");
      changed.push(node);
    }
  }
  try {
    // Chromium needs visible ancestors to compose a guest. Opacity hides the
    // host during capture without changing React's visibility or tab selection.
    if (changed.length) {
      element.getBoundingClientRect();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return await capture();
  } finally {
    for (const node of changed) {
      const count = (leases.get(node) ?? 1) - 1;
      if (count) leases.set(node, count);
      else {
        leases.delete(node);
        node.removeAttribute("data-preview-capture-paint");
      }
    }
  }
}
