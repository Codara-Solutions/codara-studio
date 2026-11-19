// Input for a browser whose extension has no debugger (Firefox): the
// DevTools protocol's Input events the trusted-input tools would send,
// played in the page as DOM events by one script per tool call. The page
// sees isTrusted false, and the browser itself does nothing it would do for
// a real device (no :hover, no caret moves, no native select or file
// dialog). What pages rely on most is done by hand, as a browser would: a
// click activates its element (the DOM does that for a dispatched click), a
// press focuses, a key with text types it into the focused field, Enter
// submits its form, a wheel scrolls what is under it, a drag of a draggable
// element runs the drag-and-drop events.

/** One protocol Input event, as tab-ops builds them for Input.dispatchMouseEvent or Input.dispatchKeyEvent. */
export type InputStep = Record<string, unknown> & { type: string };

/** What every scripted answer says, so an agent knows a page may ignore it. */
export const SCRIPTED_INPUT_NOTE =
  "This browser gives extensions no trusted input (Firefox): the events were scripted in the page, which sees isTrusted false and no :hover, and may ignore them.";

/**
 * Stringified into the page. Plays `steps` in order and says what it acted
 * on, or { ok: false, error } when a point is outside the page or in a
 * frame of another site. Keep every dependency inside.
 */
export function scriptedInputProbe(steps: InputStep[]) {
  const BUTTON: Record<string, number> = { left: 0, middle: 1, right: 2 };
  const BUTTON_BIT: Record<string, number> = { left: 1, middle: 4, right: 2 };
  const modifierInit = (bits: unknown) => {
    const mask = typeof bits === "number" ? bits : 0;
    return { altKey: (mask & 1) !== 0, ctrlKey: (mask & 2) !== 0, metaKey: (mask & 4) !== 0, shiftKey: (mask & 8) !== 0 };
  };
  // The context menu event comes with the press, except on Windows, where it comes with the release.
  const contextOnPress = !/^Win/.test(navigator.platform);
  const describe = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}` : null);

  // The element at a viewport point, through open shadow roots and frames of the same site.
  const hit = (x: number, y: number): { el: Element; x: number; y: number } | { error: string } => {
    let doc: Document = document;
    let el: Element | null = doc.elementFromPoint(x, y);
    for (;;) {
      if (!el) return { error: `Nothing at ${Math.round(x)}, ${Math.round(y)}: the point is outside the page's viewport.` };
      const inner = (el.shadowRoot as ShadowRoot | null)?.elementFromPoint(x, y);
      if (inner && inner !== el) {
        el = inner;
        continue;
      }
      if (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement) {
        let frameDoc: Document | null = null;
        try {
          frameDoc = el.contentDocument;
        } catch {
          frameDoc = null;
        }
        if (!frameDoc) return { error: "The point is in a frame from another site: scripted input cannot reach it in this browser." };
        const box = el.getBoundingClientRect();
        x -= box.left + el.clientLeft;
        y -= box.top + el.clientTop;
        doc = frameDoc;
        el = doc.elementFromPoint(x, y);
        continue;
      }
      return { el, x, y };
    }
  };

  const fire = (target: EventTarget, type: string, init: Record<string, unknown>): boolean => {
    const view = (target as Node).ownerDocument?.defaultView ?? window;
    const base = { bubbles: !/^(mouse|pointer)(enter|leave)$/.test(type), cancelable: !/^(mouse|pointer)(enter|leave)$|^dragleave$|^dragend$/.test(type), composed: true, view, ...init };
    const Ctor = type.startsWith("pointer")
      ? view.PointerEvent
      : type === "wheel"
        ? view.WheelEvent
        : type.startsWith("drag") || type === "drop"
          ? view.DragEvent
          : type.startsWith("key")
            ? view.KeyboardEvent
            : type === "beforeinput" || type === "input"
              ? view.InputEvent
              : view.MouseEvent;
    const event = new Ctor(type, type.startsWith("pointer") ? { pointerId: 1, pointerType: "mouse", isPrimary: true, ...base } : base);
    return target.dispatchEvent(event);
  };

  const pointerInit = (step: InputStep, at: { x: number; y: number }, buttons: number, extra: Record<string, unknown> = {}) => ({
    clientX: at.x,
    clientY: at.y,
    screenX: at.x,
    screenY: at.y,
    button: BUTTON[String(step.button ?? "left")] ?? 0,
    buttons,
    detail: typeof step.clickCount === "number" ? step.clickCount : 0,
    ...modifierInit(step.modifiers),
    ...extra,
  });

  const focusable = (el: Element | null): HTMLElement | null => {
    const found = el?.closest?.('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]');
    return found instanceof HTMLElement && !found.matches(":disabled") ? found : null;
  };

  // Scrolls the nearest element under the point that can scroll that way, else the page.
  const scrollFrom = (el: Element, dx: number, dy: number) => {
    const doc = el.ownerDocument;
    for (let node: Element | null = el; node; node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null)) {
      const style = getComputedStyle(node);
      const canY = dy !== 0 && /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      const canX = dx !== 0 && /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
      if (canY || canX) {
        const before = [node.scrollLeft, node.scrollTop];
        node.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior });
        if (node.scrollLeft !== before[0] || node.scrollTop !== before[1]) return describe(node);
      }
    }
    const page = doc.scrollingElement ?? doc.documentElement;
    page.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior });
    return "page";
  };

  // The focused element, through shadow roots and frames of the same site.
  const focused = (): Element => {
    let el: Element | null = document.activeElement;
    for (;;) {
      if (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      else if (el instanceof HTMLIFrameElement) {
        let inner: Element | null = null;
        try {
          inner = el.contentDocument?.activeElement ?? null;
        } catch {
          inner = null;
        }
        if (!inner) break;
        el = inner;
      } else break;
    }
    return el ?? document.body;
  };

  const isTextField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|reset|image|file|range|color|hidden)$/.test(el.type));

  // Text typed into a field as a browser would: beforeinput, the edit, input.
  const typeInto = (el: Element, inputType: string, data: string | null) => {
    const html = el as HTMLElement;
    if (isTextField(el)) {
      if (el.readOnly || el.disabled) return;
      if (!fire(el, "beforeinput", { inputType, data })) return;
      const value = el.value;
      let start: number | null = null;
      let end: number | null = null;
      try {
        start = el.selectionStart;
        end = el.selectionEnd;
      } catch {
        start = null;
      }
      // Fields without a selection (email, number) edit at the end.
      if (start === null || end === null) start = end = value.length;
      if (inputType === "deleteContentBackward" && start === end) start = Math.max(0, start - 1);
      if (inputType === "deleteContentForward" && start === end) end = Math.min(value.length, end + 1);
      const text = data ?? "";
      const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value.slice(0, start) + text + value.slice(end));
      try {
        el.setSelectionRange(start + text.length, start + text.length);
      } catch {
        // No selection on this field type.
      }
      fire(el, "input", { inputType, data, cancelable: false });
    } else if (html.isContentEditable) {
      const doc = el.ownerDocument;
      const command = inputType === "insertText" ? "insertText" : inputType === "insertParagraph" ? "insertParagraph" : inputType === "deleteContentBackward" ? "delete" : "forwardDelete";
      doc.execCommand(command, false, data ?? undefined);
    }
  };

  // A key's own action once the page did not cancel it, as a browser does it.
  const keyAction = (el: Element, step: InputStep) => {
    const key = String(step.key ?? "");
    const text = typeof step.text === "string" ? step.text : "";
    if (key === "Enter") {
      if (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return typeInto(el, "insertParagraph", el instanceof HTMLTextAreaElement ? "\n" : null);
      if (el instanceof HTMLInputElement && el.form && isTextField(el)) {
        const form = el.form;
        const submitter = Array.from(form.elements).find((item) => item.matches('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]')) as HTMLElement | undefined;
        if (!submitter) return form.requestSubmit();
        if (!submitter.matches(":disabled")) submitter.click();
        return;
      }
      if (el instanceof HTMLAnchorElement || el instanceof HTMLButtonElement || el.matches?.('[role="button"], [role="link"], summary')) return (el as HTMLElement).click();
      return;
    }
    if (key === " " && el.matches?.('button, input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"], input[type="reset"], [role="button"], [role="checkbox"], summary')) {
      return (el as HTMLElement).click();
    }
    if (key === "Backspace") return typeInto(el, "deleteContentBackward", null);
    if (key === "Delete") return typeInto(el, "deleteContentForward", null);
    if (key === "Tab") {
      const doc = el.ownerDocument;
      const order = Array.from(doc.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]'))
        .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled") && item.getClientRects().length > 0);
      if (!order.length) return;
      const here = order.indexOf(el as HTMLElement);
      const back = modifierInit(step.modifiers).shiftKey;
      order[(here + (back ? -1 : 1) + order.length) % order.length].focus();
      return;
    }
    if (text && text !== "\r" && !modifierInit(step.modifiers).ctrlKey && !modifierInit(step.modifiers).metaKey) typeInto(el, "insertText", text);
  };

  let over: Element | null = null;
  let pressed: { el: Element; button: string; x: number; y: number; mouse: boolean } | null = null;
  let dragging: { source: Element; data: DataTransfer; over: Element | null; accepted: boolean } | null = null;
  let acted: Element | null = null;
  const done: Record<string, unknown> = {};

  for (const step of steps) {
    if (step.type.startsWith("mouse")) {
      const x = Number(step.x);
      const y = Number(step.y);
      const at = hit(x, y);
      if ("error" in at) return { ok: false, error: at.error };
      const { el } = at;
      acted = el;
      const held = pressed ? BUTTON_BIT[pressed.button] ?? 1 : 0;
      if (step.type === "mouseMoved") {
        if (dragging) {
          if (dragging.over !== el) {
            if (dragging.over) fire(dragging.over, "dragleave", { ...pointerInit(step, at, held), dataTransfer: dragging.data });
            fire(el, "dragenter", { ...pointerInit(step, at, held), dataTransfer: dragging.data });
            dragging.over = el;
          }
          dragging.accepted = !fire(el, "dragover", { ...pointerInit(step, at, held), dataTransfer: dragging.data });
          continue;
        }
        if (pressed && Math.hypot(at.x - pressed.x, at.y - pressed.y) > 4) {
          const source = pressed.el.closest('[draggable="true"]') ?? (pressed.el.closest("a[href], img") as Element | null);
          if (source && (source as HTMLElement).draggable !== false) {
            const data = new DataTransfer();
            if (fire(source, "dragstart", { ...pointerInit(step, at, held), dataTransfer: data })) {
              dragging = { source, data, over: null, accepted: false };
              done.dragged = describe(source);
              continue;
            }
          }
        }
        if (el !== over) {
          if (over) {
            fire(over, "pointerout", pointerInit(step, at, held, { relatedTarget: el }));
            fire(over, "pointerleave", pointerInit(step, at, held, { relatedTarget: el }));
            fire(over, "mouseout", pointerInit(step, at, held, { relatedTarget: el }));
            fire(over, "mouseleave", pointerInit(step, at, held, { relatedTarget: el }));
          }
          fire(el, "pointerover", pointerInit(step, at, held, { relatedTarget: over }));
          fire(el, "pointerenter", pointerInit(step, at, held, { relatedTarget: over }));
          fire(el, "mouseover", pointerInit(step, at, held, { relatedTarget: over }));
          fire(el, "mouseenter", pointerInit(step, at, held, { relatedTarget: over }));
          over = el;
        }
        fire(el, "pointermove", pointerInit(step, at, held));
        fire(el, "mousemove", pointerInit(step, at, held));
      } else if (step.type === "mousePressed") {
        const button = String(step.button ?? "left");
        const bits = BUTTON_BIT[button] ?? 1;
        // A cancelled pointerdown keeps the mouse events from following, as in browsers.
        const mouse = fire(el, "pointerdown", pointerInit(step, at, bits));
        if (mouse && fire(el, "mousedown", pointerInit(step, at, bits))) {
          const target = focusable(el);
          if (target) target.focus();
          else (el.ownerDocument.activeElement as HTMLElement | null)?.blur?.();
        }
        if (button === "right" && contextOnPress) fire(el, "contextmenu", pointerInit(step, at, bits));
        pressed = { el, button, x: at.x, y: at.y, mouse };
      } else if (step.type === "mouseReleased") {
        if (dragging) {
          if (dragging.over && dragging.accepted) {
            fire(dragging.over, "drop", { ...pointerInit(step, at, 0), dataTransfer: dragging.data });
            done.dropped = describe(dragging.over);
          }
          fire(dragging.source, "dragend", { ...pointerInit(step, at, 0), dataTransfer: dragging.data });
          dragging = null;
          pressed = null;
          continue;
        }
        const button = String(step.button ?? "left");
        fire(el, "pointerup", pointerInit(step, at, 0));
        if (!pressed || pressed.mouse) fire(el, "mouseup", pointerInit(step, at, 0));
        // A click goes to the element both the press and the release were on, or their nearest common ancestor.
        let common: Element | null = pressed ? pressed.el : null;
        while (common && !common.contains(el)) common = common.parentElement;
        if (common && pressed?.button === button) {
          if (button === "left") {
            fire(common, "click", pointerInit(step, at, 0));
            if (step.clickCount === 2) fire(common, "dblclick", pointerInit(step, at, 0));
          } else if (button === "right") {
            if (!contextOnPress) fire(common, "contextmenu", pointerInit(step, at, 0));
          }
          else fire(common, "auxclick", pointerInit(step, at, 0));
        }
        pressed = null;
      } else if (step.type === "mouseWheel") {
        const dx = Number(step.deltaX) || 0;
        const dy = Number(step.deltaY) || 0;
        if (fire(el, "wheel", { ...pointerInit(step, at, 0), deltaX: dx, deltaY: dy, deltaMode: 0 })) done.scrolled = scrollFrom(el, dx, dy);
        else done.scrolled = null;
      }
    } else if (step.type === "keyDown" || step.type === "rawKeyDown" || step.type === "keyUp") {
      const el = focused();
      acted = el;
      const code = typeof step.windowsVirtualKeyCode === "number" ? step.windowsVirtualKeyCode : 0;
      const init = { key: String(step.key ?? ""), code: String(step.code ?? ""), ...modifierInit(step.modifiers) };
      const keyEvent = (type: string, keyCode: number, charCode: number) => {
        const view = el.ownerDocument.defaultView ?? window;
        const event = new view.KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, view, ...init });
        // The constructor ignores the legacy codes many pages still read.
        for (const [name, value] of [["keyCode", keyCode], ["which", keyCode || charCode], ["charCode", charCode]] as const) {
          Object.defineProperty(event, name, { get: () => value });
        }
        return el.dispatchEvent(event);
      };
      if (step.type === "keyUp") {
        keyEvent("keyup", code, 0);
        continue;
      }
      if (!keyEvent("keydown", code, 0)) continue;
      const text = typeof step.text === "string" ? step.text : "";
      if (text && !keyEvent("keypress", text === "\r" ? 13 : 0, text.codePointAt(0) ?? 0)) continue;
      keyAction(el, step);
    }
  }
  return { ok: true, target: describe(acted), ...done };
}

// Files go into the page inside the script, base64: at most this much in all.
export const SCRIPTED_UPLOAD_MAX_BYTES = 10_000_000;

const UPLOAD_TYPES: Record<string, string> = {
  txt: "text/plain", csv: "text/csv", json: "application/json", html: "text/html", md: "text/markdown", xml: "application/xml",
  pdf: "application/pdf", zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** The type a browser gives a picked file, from its extension; empty when unknown, as browsers do. */
export function uploadMimeType(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  return UPLOAD_TYPES[extension] ?? "";
}

/**
 * Stringified into the page: sets the file input's files to these, as
 * File objects, then says so with input and change, as a picked file does.
 */
export async function scriptedUploadProbe(
  options: { selector: string; files: { name: string; type: string; data: string }[] },
  createDOM: () => { find(selector: string): HTMLElement | null },
) {
  const input = createDOM().find(options.selector);
  if (!(input instanceof HTMLInputElement) || input.type !== "file") return { ok: false, error: `file input not found: ${options.selector}` };
  if (input.disabled) return { ok: false, error: "the file input is disabled" };
  if (options.files.length > 1 && !input.multiple) return { ok: false, error: "this file input takes one file" };
  const transfer = new DataTransfer();
  for (const file of options.files) {
    const raw = atob(file.data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    transfer.items.add(new File([bytes], file.name, { type: file.type }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, count: input.files?.length ?? 0 };
}
