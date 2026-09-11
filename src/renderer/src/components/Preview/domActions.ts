import type { createPreviewDOM } from "@shared/preview-dom";

// Stringified into the guest; the DOM factory is passed explicitly.
export async function clickProbe(opts: { selector: string }, createDOM: typeof createPreviewDOM) {
  const dom = createDOM();
  const el = await dom.ready(opts.selector);
  const { x, y } = dom.point(el);
  const opts2 = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 } as MouseEventInit;
  el.dispatchEvent(new PointerEvent("pointerdown", opts2 as PointerEventInit));
  el.dispatchEvent(new MouseEvent("mousedown", opts2));
  el.dispatchEvent(new PointerEvent("pointerup", opts2 as PointerEventInit));
  el.dispatchEvent(new MouseEvent("mouseup", opts2));
  if (typeof el.click === "function") el.click();
  else el.dispatchEvent(new MouseEvent("click", opts2));
  return { ok: true, tag: el.tagName.toLowerCase(), x, y };
}

export async function typeProbe(opts: { selector: string; text: string; clearFirst: boolean }, createDOM: typeof createPreviewDOM) {
  const dom = createDOM();
  const el = await dom.ready(opts.selector);
  const point = dom.point(el);
  if (el instanceof HTMLSelectElement) {
    if (el.disabled) return { ok: false, error: "select is disabled" };
    if (el.multiple) return { ok: false, error: "multiple selection is not supported by type" };
    const option = Array.from(el.options).find((option) => option.value === opts.text);
    if (!option) return { ok: false, error: `select has no option with value: ${opts.text}` };
    if (option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)) {
      return { ok: false, error: "select option is disabled" };
    }
    el.focus();
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: el.value, ...point };
  }
  if (el instanceof HTMLInputElement && /^(file|checkbox|radio|button|submit|reset|image|range|color)$/.test(el.type)) {
    return { ok: false, error: "Use click for buttons and toggles, or upload for file inputs." };
  }
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  if (input.readOnly) return { ok: false, error: "element is readonly" };
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // React tracks the instance setter; use the native setter before notifying it.
    const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
    setter.call(input, (opts.clearFirst ? "" : input.value) + opts.text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else if ((el as HTMLElement).isContentEditable) {
    if (opts.clearFirst) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    document.execCommand("insertText", false, opts.text);
  } else {
    return { ok: false, error: "element is not an input, textarea, or contentEditable" };
  }
  return { ok: true, ...point };
}

export async function pressKeyProbe(opts: { key: string; selector: string | null }, createDOM: typeof createPreviewDOM) {
  const target = (opts.selector ? await createDOM().ready(opts.selector) : document.activeElement) as HTMLElement | null;
  const dispatchOn = target ?? document.body;
  const keyName = opts.key;
  const keyCodeMap: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32 };
  const keyCode = keyCodeMap[keyName] ?? (keyName.length === 1 ? keyName.charCodeAt(0) : 0);
  const init = { key: keyName === "Space" ? " " : keyName, code: keyName, keyCode, which: keyCode, bubbles: true, cancelable: true } as KeyboardEventInit;
  dispatchOn.dispatchEvent(new KeyboardEvent("keydown", init));
  dispatchOn.dispatchEvent(new KeyboardEvent("keypress", init));
  dispatchOn.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ok: true, target: dispatchOn?.tagName?.toLowerCase?.() ?? null };
}

export function waitForProbe(opts: { selector: string; state: string; timeoutMs: number }, createDOM: typeof createPreviewDOM) {
  const dom = createDOM();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + opts.timeoutMs;
    const check = () => {
      let el: HTMLElement | null;
      try { el = dom.find(opts.selector, opts.state === "hidden"); } catch (error) { reject(error); return; }
      let match = false;
      if (opts.state === "attached") match = el !== null;
      else {
        const visible = !!el && dom.visible(el);
        match = opts.state === "hidden" ? !visible : visible;
      }
      if (match) return resolve({ ok: true, foundAt: new Date().toISOString() });
      if (Date.now() >= deadline) return resolve({ ok: false, error: `timed out waiting for '${opts.selector}' to be ${opts.state}` });
      setTimeout(check, 75);
    };
    check();
  });
}
