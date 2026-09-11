// Stringified into the browser guest. Keep all dependencies inside this factory.
export function createPreviewDOM() {
  type State = { prefix: string; next: number; refs: Map<string, Element>; ids: WeakMap<Element, string> };
  const host = window as unknown as { __codaraPreviewDOM?: State };
  const state = host.__codaraPreviewDOM ??= {
    prefix: Array.from(crypto.getRandomValues(new Uint32Array(2)), value => value.toString(36)).join(""), next: 0, refs: new Map(), ids: new WeakMap(),
  };
  for (const [id, el] of state.refs) if (!el.isConnected) state.refs.delete(id);
  function ref(el: Element): string {
    let id = state.ids.get(el);
    if (!id) {
      id = `@${state.prefix}-${++state.next}`;
      state.ids.set(el, id);
    }
    state.refs.set(id, el);
    return id;
  }
  function find(selector: string, allowDetached = false): HTMLElement | null {
    if (selector.startsWith("@")) {
      const el = state.refs.get(selector);
      if (!el?.isConnected) {
        if (allowDetached) return null;
        throw new Error(`Stale element reference ${selector}. Take a new snapshot.`);
      }
      return el as HTMLElement;
    }
    const matches = document.querySelectorAll<HTMLElement>(selector);
    if (matches.length > 1) throw new Error(`Ambiguous selector ${JSON.stringify(selector)} matches ${matches.length} elements. Use a reference from a snapshot.`);
    return matches[0] ?? null;
  }
  function visible(el: Element): boolean {
    if (el.closest('[inert], [aria-hidden="true"]')) return false;
    const modal = Array.from(document.querySelectorAll("dialog:modal")).at(-1);
    if (modal && !modal.contains(el)) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.visibility !== "collapse" && el.getClientRects().length > 0;
  }
  function point(el: Element) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2,
      y: Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2,
    };
  }
  async function ready(selector: string, timeoutMs = 1500): Promise<HTMLElement> {
    const deadline = Date.now() + Math.min(10_000, Math.max(0, timeoutMs));
    let reason = "not found";
    do {
      const el = find(selector);
      if (el && visible(el)) {
        if (el.matches(':disabled, [aria-disabled="true"]')) reason = "disabled";
        else {
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          const { x, y } = point(el);
          const hit = document.elementFromPoint(x, y);
          if (hit && (el === hit || el.contains(hit))) return el;
          reason = "covered by another element";
        }
      } else if (el) reason = "hidden or inert";
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (true);
    throw new Error(`Cannot interact with ${selector}: ${reason}. Take a new snapshot.`);
  }
  return { ref, find, visible, ready, point };
}
