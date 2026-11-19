// Input for a browser whose extension has no debugger (Firefox): the
// DevTools protocol's Input events the trusted-input tools would send,
// played in the page as DOM events by one script per tool call. The page
// sees isTrusted false, and the browser itself does nothing it would do for
// a real device (no :hover, no caret moves, no native select or file
// dialog). What pages rely on most is done by hand, as a browser would: a
// click activates its element (the DOM does that for a dispatched click), a
// press focuses, a key with text types it into the focused field, Enter
// submits a form as HTML's implicit submission does, a wheel scrolls what is
// under it, a drag of a draggable element runs the drag-and-drop events.
// Where the pointer is, and what is pressed or dragged, carries over from
// one call to the next in the same page, as a real mouse does.

/** One protocol Input event, as tab-ops builds them for Input.dispatchMouseEvent or Input.dispatchKeyEvent, or { type: "focus", selector }. */
export type InputStep = Record<string, unknown> & { type: string };

/** What every scripted answer says, so an agent knows a page may ignore it. */
export const SCRIPTED_INPUT_NOTE =
  "This browser gives extensions no trusted input (Firefox): the events were scripted in the page, which sees isTrusted false and no :hover, and may ignore them.";

/**
 * Stringified into the page. Plays `steps` in order and says what it acted
 * on, or { ok: false, error } when a point is outside the page or in a
 * frame of another site. `createDOM` (preview-dom.ts) resolves a focus
 * step's selector. Keep every dependency inside.
 */
export async function scriptedInputProbe(steps: InputStep[], createDOM?: () => { ready(selector: string): Promise<HTMLElement | null> }) {
  const BUTTON: Record<string, number> = { left: 0, middle: 1, right: 2 };
  const BUTTON_BIT: Record<string, number> = { left: 1, middle: 4, right: 2 };
  // The context menu event comes with the press, except on Windows, where it comes with the release.
  const contextOnPress = !/^Win/.test(navigator.platform);
  const modifierInit = (bits: unknown) => {
    const mask = typeof bits === "number" ? bits : 0;
    return { altKey: (mask & 1) !== 0, ctrlKey: (mask & 2) !== 0, metaKey: (mask & 4) !== 0, shiftKey: (mask & 8) !== 0 };
  };
  const describe = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}` : null);
  // instanceof against the element's own window: an element of a same-site frame is not one of the top window's.
  const is = (el: unknown, name: string): boolean => {
    const view = ((el as Node | null)?.ownerDocument?.defaultView ?? window) as unknown as Record<string, unknown>;
    const Ctor = view[name] as (abstract new () => unknown) | undefined;
    return Boolean(el && Ctor && el instanceof Ctor);
  };
  const viewOf = (el: Element): Window & typeof globalThis => (el.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
  // The parent across a shadow root's boundary, or null at the document.
  const parentOf = (el: Element): Element | null => el.parentElement ?? (((el.getRootNode() as ShadowRoot).host as Element | undefined) ?? null);

  // Pointer state for this page, kept from one call to the next.
  type Pointer = {
    over: Element | null;
    pressed: { el: Element; button: string; x: number; y: number; mouse: boolean; dragTried: boolean } | null;
    dragging: { source: Element; data: DataTransfer; over: Element | null; accepted: boolean } | null;
  };
  const KEY = Symbol.for("codara.scriptedPointer");
  const store = window as unknown as Record<symbol, Pointer | undefined>;
  const pointer: Pointer = store[KEY] ?? { over: null, pressed: null, dragging: null };
  Object.defineProperty(window, KEY, { value: pointer, configurable: true, enumerable: false });
  const alive = (el: Element | null) => (el && el.isConnected ? el : null);
  pointer.over = alive(pointer.over);
  if (pointer.pressed && !alive(pointer.pressed.el)) pointer.pressed = null;
  if (pointer.dragging && !alive(pointer.dragging.source)) pointer.dragging = null;

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
      if (is(el, "HTMLIFrameElement") || is(el, "HTMLFrameElement")) {
        const frame = el as HTMLIFrameElement;
        let frameDoc: Document | null = null;
        try {
          frameDoc = frame.contentDocument;
        } catch {
          frameDoc = null;
        }
        if (!frameDoc) return { error: "The point is in a frame from another site: scripted input cannot reach it in this browser." };
        const box = frame.getBoundingClientRect();
        x -= box.left + frame.clientLeft;
        y -= box.top + frame.clientTop;
        doc = frameDoc;
        el = doc.elementFromPoint(x, y);
        continue;
      }
      return { el, x, y };
    }
  };

  const fire = (target: EventTarget, type: string, init: Record<string, unknown>): boolean => {
    const view = viewOf(target as Element);
    const boundary = /^(mouse|pointer)(enter|leave)$/.test(type);
    const base = { bubbles: !boundary, cancelable: !boundary && !/^(dragleave|dragend)$/.test(type), composed: !boundary, view, ...init };
    const Ctor = type.startsWith("pointer")
      ? view.PointerEvent
      : type === "wheel"
        ? view.WheelEvent
        : type.startsWith("drag") || type === "drop"
          ? view.DragEvent
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

  // The pointer crossing from one element to another: out and leave up from
  // the old one to their common ancestor, over and enter down to the new one.
  const cross = (from: Element | null, to: Element, init: (related: Element | null) => Record<string, unknown>) => {
    const chain = (el: Element | null) => {
      const out: Element[] = [];
      for (let node = el; node; node = parentOf(node)) out.push(node);
      return out;
    };
    const fromChain = chain(from);
    const toChain = chain(to);
    const shared = new Set(fromChain.filter((node) => toChain.includes(node)));
    if (from) {
      fire(from, "pointerout", init(to));
      for (const node of fromChain) if (!shared.has(node)) fire(node, "pointerleave", init(to));
      fire(from, "mouseout", init(to));
      for (const node of fromChain) if (!shared.has(node)) fire(node, "mouseleave", init(to));
    }
    const entering = toChain.filter((node) => !shared.has(node)).reverse();
    fire(to, "pointerover", init(from));
    for (const node of entering) fire(node, "pointerenter", init(from));
    fire(to, "mouseover", init(from));
    for (const node of entering) fire(node, "mouseenter", init(from));
  };

  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
  const focusable = (el: Element | null): HTMLElement | null => {
    const found = el?.closest?.(FOCUSABLE);
    return found && is(found, "HTMLElement") && !found.matches(":disabled") ? (found as HTMLElement) : null;
  };

  // Scrolls the nearest element under the point that can scroll that way, else the page.
  // A box at its end whose overscroll-behavior is contain or none stops the wheel there.
  const scrollFrom = (el: Element, dx: number, dy: number): string | null => {
    const doc = el.ownerDocument;
    const view = viewOf(el);
    for (let node: Element | null = el; node && node !== doc.documentElement && node !== doc.body; node = parentOf(node)) {
      const style = view.getComputedStyle(node);
      const scrollerY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      const scrollerX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
      if ((dy !== 0 && scrollerY) || (dx !== 0 && scrollerX)) {
        const before = [node.scrollLeft, node.scrollTop];
        node.scrollBy({ left: scrollerX ? dx : 0, top: scrollerY ? dy : 0, behavior: "instant" as ScrollBehavior });
        if (node.scrollLeft !== before[0] || node.scrollTop !== before[1]) return describe(node);
        const held = (axis: string) => /^(contain|none)$/.test(axis);
        if ((dy !== 0 && scrollerY && held(style.overscrollBehaviorY)) || (dx !== 0 && scrollerX && held(style.overscrollBehaviorX))) return null;
      }
    }
    const page = doc.scrollingElement ?? doc.documentElement;
    const before = [page.scrollLeft, page.scrollTop];
    page.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior });
    return page.scrollLeft !== before[0] || page.scrollTop !== before[1] ? "page" : null;
  };

  // The focused element, through shadow roots and frames of the same site.
  const focused = (): { el: Element } | { error: string } => {
    let el: Element | null = document.activeElement;
    for (;;) {
      if (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      else if (is(el, "HTMLIFrameElement") || is(el, "HTMLFrameElement")) {
        let inner: Document | null = null;
        try {
          inner = (el as HTMLIFrameElement).contentDocument;
        } catch {
          inner = null;
        }
        if (!inner) return { error: "The focused element is in a frame from another site: scripted keys cannot reach it in this browser." };
        el = inner.activeElement ?? inner.body;
      } else break;
    }
    return { el: el ?? document.body };
  };

  const TEXT_TYPES = /^(text|search|url|tel|email|password|number|date|month|week|time|datetime-local)$/;
  const isTextField = (el: Element): boolean =>
    is(el, "HTMLTextAreaElement") || (is(el, "HTMLInputElement") && !/^(checkbox|radio|button|submit|reset|image|file|range|color|hidden)$/.test((el as HTMLInputElement).type));

  // Where the character before or after a caret begins or ends (whole emoji and accented letters, not half of one).
  const boundary = (text: string, at: number, forward: boolean): number => {
    const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(text: string): Iterable<{ index: number; segment: string }> } }).Segmenter;
    if (Segmenter) {
      let last = 0;
      for (const { index, segment } of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
        if (forward && index >= at) return index + segment.length;
        if (!forward && index + segment.length >= at) return index;
        last = index + segment.length;
      }
      return forward ? text.length : last;
    }
    const step = forward ? (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1 : at >= 2 && /[\udc00-\udfff]/.test(text[at - 1]) && /[\ud800-\udbff]/.test(text[at - 2]) ? 2 : 1;
    return forward ? Math.min(text.length, at + step) : Math.max(0, at - step);
  };

  // Text typed into a field as a browser would: beforeinput, the edit (within maxlength), input.
  const typeInto = (el: Element, inputType: string, data: string | null) => {
    if (isTextField(el)) {
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      if (field.readOnly || field.disabled) return;
      const value = field.value;
      let start: number | null = null;
      let end: number | null = null;
      try {
        start = field.selectionStart;
        end = field.selectionEnd;
      } catch {
        start = null;
      }
      // Fields without a selection (email, number) edit at the end.
      if (start === null || end === null) start = end = value.length;
      if (inputType === "deleteContentBackward" && start === end) start = boundary(value, start, false);
      if (inputType === "deleteContentForward" && start === end) end = boundary(value, end, true);
      let text = data ?? "";
      // A field at its maxlength takes no more, as a browser does.
      if (text && field.maxLength >= 0) {
        const room = field.maxLength - (value.length - (end - start));
        if (room <= 0) return;
        if (text.length > room) text = text.slice(0, room);
      }
      if (start === end && !text) return;
      if (!fire(el, "beforeinput", { inputType, data: text || data })) return;
      const prototype = (viewOf(el) as unknown as Record<string, { prototype: object }>)[is(el, "HTMLInputElement") ? "HTMLInputElement" : "HTMLTextAreaElement"].prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value.slice(0, start) + text + value.slice(end));
      try {
        field.setSelectionRange(start + text.length, start + text.length);
      } catch {
        // No selection on this field type.
      }
      fire(el, "input", { inputType, data: text || data, cancelable: false });
    } else if ((el as HTMLElement).isContentEditable) {
      const command = inputType === "insertText" ? "insertText" : inputType === "insertParagraph" ? "insertParagraph" : inputType === "deleteContentBackward" ? "delete" : "forwardDelete";
      el.ownerDocument.execCommand(command, false, data ?? undefined);
    }
  };

  // HTML's implicit submission: Enter in a field presses the form's default
  // button; with none, the form is sent only when that field is its only one.
  const implicitSubmit = (field: HTMLInputElement) => {
    const form = field.form;
    if (!form) return;
    const elements = Array.from(form.elements);
    const submitter = elements.find((item) => item.matches('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]')) as HTMLElement | undefined;
    if (submitter) {
      if (!submitter.matches(":disabled")) submitter.click();
      return;
    }
    const blocking = elements.filter((item) => is(item, "HTMLInputElement") && TEXT_TYPES.test((item as HTMLInputElement).type));
    if (blocking.length === 1) form.requestSubmit();
  };

  // A key's own action once the page did not cancel it, as a browser does it; only native controls are activated.
  const keyAction = (el: Element, step: InputStep) => {
    const key = String(step.key ?? "");
    const text = typeof step.text === "string" ? step.text : "";
    const mods = modifierInit(step.modifiers);
    if (key === "Enter") {
      if (is(el, "HTMLTextAreaElement")) return typeInto(el, "insertParagraph", "\n");
      if ((el as HTMLElement).isContentEditable) return typeInto(el, "insertParagraph", null);
      if (is(el, "HTMLInputElement") && TEXT_TYPES.test((el as HTMLInputElement).type)) return implicitSubmit(el as HTMLInputElement);
      if (el.matches?.('a[href], button, input[type="submit"], input[type="reset"], input[type="button"], input[type="image"], summary') && !el.matches(":disabled")) {
        return (el as HTMLElement).click();
      }
      return;
    }
    if (key === " " && el.matches?.('button, input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], summary') && !el.matches(":disabled")) {
      return (el as HTMLElement).click();
    }
    if (key === "Backspace") return typeInto(el, "deleteContentBackward", null);
    if (key === "Delete") return typeInto(el, "deleteContentForward", null);
    if (key === "Tab") {
      const order = Array.from(el.ownerDocument.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled") && item.getClientRects().length > 0);
      if (!order.length) return;
      const here = order.indexOf(el as HTMLElement);
      order[(here + (mods.shiftKey ? -1 : 1) + order.length) % order.length].focus();
      return;
    }
    if (text && text !== "\r" && !mods.ctrlKey && !mods.metaKey) typeInto(el, "insertText", text);
  };

  let acted: Element | null = null;
  // The element keys go to after a focus step, resolved once in this same script.
  let keyTarget: Element | null = null;
  const done: Record<string, unknown> = {};

  for (const step of steps) {
    if (step.type === "focus") {
      const selector = String(step.selector ?? "");
      const el = createDOM ? await createDOM().ready(selector) : null;
      if (!el || typeof el.focus !== "function") return { ok: false, error: `key target is missing or not focusable: ${selector}` };
      el.focus();
      const now = focused();
      if ("error" in now || (now.el !== el && !el.contains(now.el))) return { ok: false, error: `key target is missing or not focusable: ${selector}` };
      keyTarget = now.el;
      continue;
    }
    if (step.type.startsWith("mouse")) {
      const at = hit(Number(step.x), Number(step.y));
      if ("error" in at) return { ok: false, error: at.error };
      const { el } = at;
      acted = el;
      const held = pointer.pressed ? BUTTON_BIT[pointer.pressed.button] ?? 1 : 0;
      if (step.type === "mouseMoved") {
        // Pressed and moved far enough on something draggable: the drag starts, and this same move goes on as part of it.
        const pressed = pointer.pressed;
        if (!pointer.dragging && pressed && !pressed.dragTried && pressed.button === "left" && Math.hypot(at.x - pressed.x, at.y - pressed.y) > 4) {
          pressed.dragTried = true;
          const source = pressed.el.closest('[draggable="true"], a[href], img');
          if (source && (source as HTMLElement).draggable) {
            const data = new (viewOf(source).DataTransfer)();
            if (fire(source, "dragstart", { ...pointerInit(step, at, held), dataTransfer: data })) {
              pointer.dragging = { source, data, over: null, accepted: false };
              done.dragged = describe(source);
            }
          }
        }
        const dragging = pointer.dragging;
        if (dragging) {
          fire(dragging.source, "drag", { ...pointerInit(step, at, held), dataTransfer: dragging.data });
          if (dragging.over !== el) {
            fire(el, "dragenter", { ...pointerInit(step, at, held), dataTransfer: dragging.data });
            if (dragging.over) fire(dragging.over, "dragleave", { ...pointerInit(step, at, held), dataTransfer: dragging.data });
            dragging.over = el;
          }
          dragging.accepted = !fire(el, "dragover", { ...pointerInit(step, at, held), dataTransfer: dragging.data });
          continue;
        }
        if (el !== pointer.over) {
          cross(pointer.over, el, (related) => pointerInit(step, at, held, { relatedTarget: related }));
          pointer.over = el;
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
        pointer.pressed = { el, button, x: at.x, y: at.y, mouse, dragTried: false };
      } else if (step.type === "mouseReleased") {
        const dragging = pointer.dragging;
        if (dragging) {
          if (dragging.over && dragging.accepted) {
            fire(dragging.over, "drop", { ...pointerInit(step, at, 0), dataTransfer: dragging.data });
            done.dropped = describe(dragging.over);
          } else if (dragging.over) fire(dragging.over, "dragleave", { ...pointerInit(step, at, 0), dataTransfer: dragging.data });
          fire(dragging.source, "dragend", { ...pointerInit(step, at, 0), dataTransfer: dragging.data });
          pointer.dragging = null;
          pointer.pressed = null;
          continue;
        }
        const button = String(step.button ?? "left");
        const pressed = pointer.pressed;
        fire(el, "pointerup", pointerInit(step, at, 0));
        if (!pressed || pressed.mouse) fire(el, "mouseup", pointerInit(step, at, 0));
        // A click goes to the element both the press and the release were on, or their nearest common ancestor.
        let common: Element | null = pressed ? pressed.el : null;
        while (common && !common.contains(el)) common = parentOf(common);
        if (common && pressed?.button === button && pressed.mouse) {
          if (button === "left") {
            fire(common, "click", pointerInit(step, at, 0));
            if (step.clickCount === 2) fire(common, "dblclick", pointerInit(step, at, 0));
          } else {
            if (button === "right" && !contextOnPress) fire(common, "contextmenu", pointerInit(step, at, 0));
            fire(common, "auxclick", pointerInit(step, at, 0));
          }
        }
        pointer.pressed = null;
      } else if (step.type === "mouseWheel") {
        const dx = Number(step.deltaX) || 0;
        const dy = Number(step.deltaY) || 0;
        done.scrolled = fire(el, "wheel", { ...pointerInit(step, at, 0), deltaX: dx, deltaY: dy, deltaMode: 0 }) ? scrollFrom(el, dx, dy) : null;
      }
    } else if (step.type === "keyDown" || step.type === "rawKeyDown" || step.type === "keyUp") {
      let el: Element;
      if (keyTarget && keyTarget.isConnected) el = keyTarget;
      else {
        const now = focused();
        if ("error" in now) return { ok: false, error: now.error };
        el = now.el;
      }
      acted = el;
      const code = typeof step.windowsVirtualKeyCode === "number" ? step.windowsVirtualKeyCode : 0;
      const init = { key: String(step.key ?? ""), code: String(step.code ?? ""), ...modifierInit(step.modifiers) };
      const keyEvent = (type: string, keyCode: number, charCode: number) => {
        const view = viewOf(el);
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
  txt: "text/plain", text: "text/plain", log: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", md: "text/markdown",
  xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", ics: "text/calendar", vcf: "text/vcard", rtf: "application/rtf",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  bmp: "image/bmp", ico: "image/vnd.microsoft.icon", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac", opus: "audio/opus",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", wasm: "application/wasm",
};

/** The type a browser gives a picked file, from its extension; empty when unknown, as browsers do. */
export function uploadMimeType(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  return UPLOAD_TYPES[extension] ?? "";
}

/** Where a pinned file input waits in the page between the two steps of an upload (a Symbol.for key). */
export const SCRIPTED_UPLOAD_PIN_KEY = "codara.uploadPins";

/**
 * Stringified into the page, before Codara reads any file: finds the file
 * input, checks it takes these files, and pins it under `pin` in this
 * document only. A page that replaced it (a navigation) has no such pin.
 */
export async function scriptedUploadPinProbe(
  options: { selector: string; count: number; pin: string; key: string },
  createDOM: () => { find(selector: string): HTMLElement | null },
) {
  const input = createDOM().find(options.selector);
  const view = (input?.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
  if (!input || !(input instanceof view.HTMLInputElement) || input.type !== "file") return { ok: false, error: `file input not found: ${options.selector}` };
  if (input.disabled) return { ok: false, error: "the file input is disabled" };
  if (options.count > 1 && !input.multiple) return { ok: false, error: "this file input takes one file" };
  const key = Symbol.for(options.key);
  const store = window as unknown as Record<symbol, Map<string, HTMLInputElement> | undefined>;
  const pins = store[key] ?? new Map<string, HTMLInputElement>();
  Object.defineProperty(window, key, { value: pins, configurable: true, enumerable: false });
  pins.set(options.pin, input);
  return { ok: true };
}

/**
 * Stringified into the page: sets the pinned file input's files to these,
 * as File objects, then says so with input and change, as a picked file
 * does. Without the pin (another page now) nothing is set.
 */
export async function scriptedUploadProbe(options: { pin: string; key: string; files: { name: string; type: string; lastModified: number; data: string }[] }) {
  const pins = (window as unknown as Record<symbol, Map<string, HTMLInputElement> | undefined>)[Symbol.for(options.key)];
  const input = pins?.get(options.pin);
  pins?.delete(options.pin);
  if (!input || !input.isConnected) return { ok: false, error: "The page changed while the files were read: nothing was uploaded." };
  const view = (input.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
  const transfer = new view.DataTransfer();
  for (const file of options.files) {
    const raw = atob(file.data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    transfer.items.add(new view.File([bytes], file.name, { type: file.type, lastModified: file.lastModified }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
  return { ok: true, count: input.files?.length ?? 0 };
}
