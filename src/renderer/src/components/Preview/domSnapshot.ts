import type { createPreviewDOM } from "@shared/preview-dom";

// Executed in the guest, with the factory passed explicitly across the boundary.
export function snapshotProbe(opts: { mode: string; maxBytes: number; selector?: string | null; since?: string | null }, createDOM: typeof createPreviewDOM) {
  const dom = createDOM();
  const encoder = new TextEncoder();
  const limit = Number.isFinite(opts.maxBytes) ? Math.max(1, Math.min(100_000, Math.floor(opts.maxBytes))) : 12_000;
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  function add(line: string) {
    const size = encoder.encode((lines.length ? "\n" : "") + line).length;
    if (bytes + size > limit) { truncated = true; return; }
    lines.push(line);
    bytes += size;
  }
  function walk(el: Element, depth: number) {
    if (truncated || /^(SCRIPT|STYLE|NOSCRIPT|META|LINK|OPTION|OPTGROUP)$/.test(el.tagName) ||
        el.matches("[inert], [aria-hidden=\"true\"]") || getComputedStyle(el).display === "none") return;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || ({ a: "link", button: "button", select: "combobox", textarea: "textbox",
      h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
      dialog: "dialog", th: "columnheader", td: "cell", tr: "row", table: "table", li: "listitem", img: "image",
      summary: "button", iframe: "frame" } as Record<string, string>)[tag] ||
      (tag === "input" ? ({ checkbox: "checkbox", radio: "radio", range: "slider", button: "button",
        submit: "button", reset: "button", image: "button", number: "spinbutton", search: "searchbox" } as Record<string, string>)[(el as HTMLInputElement).type] || "textbox" : "");
    const control = el.matches("a[href], button, input, textarea, select, summary, [contenteditable=\"true\"], [tabindex], [role=\"button\"], [role=\"checkbox\"], [role=\"link\"], [role=\"tab\"], [role=\"switch\"], [role=\"textbox\"], [role=\"combobox\"]");
    const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent).filter(Boolean).join(" ");
    const labels = "labels" in el ? Array.from((el as HTMLInputElement).labels ?? []).map(label => {
      const clone = label.cloneNode(true) as Element;
      clone.querySelectorAll("input, select, textarea, button").forEach(node => node.remove());
      return clone.textContent;
    }).join(" ") : "";
    const ownText = Array.from(el.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(" ");
    // Focusable containers (dialogs, panels, tables) still expose their children.
    const leaf = /^(a|button|input|textarea|select|summary|img|iframe|h[1-6])$/.test(tag) ||
      el.matches("[contenteditable=\"true\"], [role=\"button\"], [role=\"checkbox\"], [role=\"link\"], [role=\"tab\"], [role=\"switch\"], [role=\"textbox\"]");
    const name = clean(el.getAttribute("aria-label") || labelledBy || labels || el.getAttribute("alt") || el.getAttribute("title") || (tag === "input" && role === "button" ? (el as HTMLInputElement).value : "") ||
      (leaf ? (el as HTMLElement).innerText : ownText));
    let emitted = false;
    if (dom.visible(el) && (role || control || (name && tag !== "label"))) {
      const parts = [role || (control ? "control" : "text")];
      if (control) parts.push(dom.ref(el));
      if (el.id) parts.push(`#${el.id}`);
      if (name) parts.push(JSON.stringify(name.slice(0, 300)));
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        parts.push(`value=${JSON.stringify(el instanceof HTMLInputElement && el.type === "password" ? "[redacted]" : el.value)}`);
        if (el instanceof HTMLInputElement && /^(checkbox|radio)$/.test(el.type)) parts.push(`checked=${el.checked}`);
        if ("readOnly" in el && el.readOnly) parts.push("readonly");
      }
      for (const attr of ["aria-expanded", "aria-checked", "aria-selected", "aria-busy"]) {
        if (el.hasAttribute(attr)) parts.push(`${attr.slice(5)}=${el.getAttribute(attr)}`);
      }
      if (el.matches(":disabled, [aria-disabled=\"true\"]")) parts.push("disabled");
      if (el instanceof HTMLSelectElement) parts.push(`options=${JSON.stringify(Array.from(el.options).map(option => ({
        value: option.value, label: option.label,
        ...(option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) ? { disabled: true } : {}),
      })))}`);
      if (tag === "iframe") parts.push("(frame content requires visual inspection)");
      add("  ".repeat(depth) + parts.join(" "));
      emitted = true;
    }
    if (!leaf) for (const child of Array.from(el.children)) walk(child, depth + (emitted ? 1 : 0));
  }
  const root = opts.selector ? dom.find(opts.selector) : Array.from(document.querySelectorAll("dialog:modal")).at(-1) ?? document.body;
  if (!root) throw new Error(`Snapshot scope not found: ${opts.selector}`);
  walk(root, 0);
  type Previous = { id: string; scope: string; lines: string[]; truncated: boolean };
  const host = window as unknown as { __codaraPreviewSnapshot?: Previous };
  const previous = host.__codaraPreviewSnapshot;
  const scope = opts.selector ?? "";
  const id = Array.from(crypto.getRandomValues(new Uint32Array(2)), value => value.toString(36)).join("-");
  host.__codaraPreviewSnapshot = { id, scope, lines, truncated };
  const base = { url: location.href, title: document.title, mode: opts.mode, snapshotId: id, truncated };
  if (opts.since && previous?.id === opts.since && previous.scope === scope && !previous.truncated && !truncated) {
    // Include position in the diff so repeated text and reordering remain observable.
    const before = new Set(previous.lines.map((line, i) => `${i + 1}: ${line}`));
    const after = new Set(lines.map((line, i) => `${i + 1}: ${line}`));
    const changes = [...before].filter(line => !after.has(line)).map(line => `- ${line}`)
      .concat([...after].filter(line => !before.has(line)).map(line => `+ ${line}`)).join("\n");
    const diff = changes || "(unchanged)";
    if (encoder.encode(diff).length < bytes) return { ...base, diff: true, snapshot: diff };
  }
  return { ...base, diff: false, snapshot: lines.join("\n") };
}
