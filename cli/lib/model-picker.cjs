"use strict";

// A small, two-step model picker. The first screen chooses a model; the second
// chooses its reasoning depth. One decision at a time keeps the terminal fast
// to scan and matches the Studio composer.

const { c } = require("./ui.cjs");

const DEFAULT_EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]);
const EFFORT_HINTS = Object.freeze({
  minimal: "quickest",
  low: "fast",
  medium: "balanced",
  high: "thorough",
  xhigh: "deep",
  max: "maximum",
});

function providerLabel(model) {
  if (model.provider === "anthropic" || model.id.startsWith("claude-")) return "Anthropic";
  if (model.provider === "openai-codex" || model.id.startsWith("gpt-")) return "OpenAI";
  return model.provider || "";
}

function modelEfforts(model) {
  return Array.isArray(model.thinkingLevels) ? model.thinkingLevels.filter(Boolean) : DEFAULT_EFFORTS;
}

function closestEffort(levels, preferred) {
  if (levels.length === 0) return undefined;
  if (levels.includes(preferred)) return preferred;
  if (levels.includes("medium")) return "medium";
  return levels[0];
}

function createModelEffortPicker({
  models,
  currentModel,
  currentEffort,
  onApply,
  onCancel,
  requestRender,
  ui,
}) {
  const catalog = Array.isArray(models) && models.length ? models : [];
  const { matchesKey, truncateToWidth, visibleWidth } = ui;

  class ModelEffortPicker {
    constructor() {
      this.focused = false;
      this.phase = "model";
      this.selectedIndex = Math.max(0, catalog.findIndex((model) => model.id === currentModel));
      this.effortByModel = new Map();
      this.busy = false;
      this.error = "";
    }

    invalidate() {}

    selectedModel() {
      return catalog[this.selectedIndex];
    }

    selectedEffort() {
      const model = this.selectedModel();
      if (!model) return undefined;
      const levels = modelEfforts(model);
      return closestEffort(levels, this.effortByModel.get(model.id) || currentEffort);
    }

    moveModel(delta) {
      if (catalog.length === 0) return;
      this.selectedIndex = (this.selectedIndex + delta + catalog.length) % catalog.length;
      this.error = "";
      requestRender();
    }

    moveEffort(delta) {
      const model = this.selectedModel();
      if (!model) return;
      const levels = modelEfforts(model);
      if (levels.length === 0) return;
      const index = Math.max(0, levels.indexOf(this.selectedEffort()));
      this.effortByModel.set(model.id, levels[(index + delta + levels.length) % levels.length]);
      this.error = "";
      requestRender();
    }

    goBack() {
      if (this.phase === "effort") {
        this.phase = "model";
        this.error = "";
        requestRender();
      } else {
        onCancel();
      }
    }

    apply() {
      const model = this.selectedModel();
      if (!model) return;
      this.busy = true;
      this.error = "";
      requestRender();
      Promise.resolve(onApply({ model, effort: this.selectedEffort() })).catch((error) => {
        this.busy = false;
        this.error = error instanceof Error ? error.message : String(error);
        requestRender();
      });
    }

    handleInput(data) {
      if (this.busy) return;

      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.goBack();
        return;
      }

      if (this.phase === "effort") {
        if (matchesKey(data, "up") || matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
          this.moveEffort(-1);
        } else if (matchesKey(data, "down") || matchesKey(data, "right") || matchesKey(data, "tab")) {
          this.moveEffort(1);
        } else if (matchesKey(data, "backspace")) {
          this.goBack();
        } else if (matchesKey(data, "enter")) {
          this.apply();
        }
        return;
      }

      if (matchesKey(data, "up")) this.moveModel(-1);
      else if (matchesKey(data, "down")) this.moveModel(1);
      else if (matchesKey(data, "enter")) {
        const model = this.selectedModel();
        if (!model) return;
        if (modelEfforts(model).length === 0) this.apply();
        else {
          this.phase = "effort";
          this.error = "";
          requestRender();
        }
      }
    }

    render(width) {
      const boxWidth = Math.max(3, width);
      const innerWidth = Math.max(1, boxWidth - 2);
      const line = (content = "", style) => {
        const clipped = truncateToWidth(content, innerWidth, "");
        const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
        return `${c.violet("│")}${style ? style(padded) : padded}${c.violet("│")}`;
      };
      const divider = () => `${c.violet("├")}${c.violet("─".repeat(innerWidth))}${c.violet("┤")}`;
      const model = this.selectedModel();
      const title = this.phase === "model"
        ? `  ${c.violet("◆")} ${c.bold("CHOOSE MODEL")}`
        : `  ${c.dim("‹")} ${c.bold(model?.label || model?.id || "MODEL")}`;
      const lines = [
        `${c.violet("╭")}${c.violet("─".repeat(innerWidth))}${c.violet("╮")}`,
        line(title, c.surface),
        divider(),
      ];

      if (this.phase === "effort") this.renderEfforts(lines, line);
      else this.renderModels(lines, line, innerWidth, visibleWidth, truncateToWidth);

      lines.push(divider());
      if (this.error) {
        lines.push(line(`  ${c.red(truncateToWidth(this.error, Math.max(1, innerWidth - 4), "…"))}`));
      } else if (this.busy) {
        lines.push(line(`  ${c.cyan("✦ Applying…")}`));
      } else if (this.phase === "effort") {
        lines.push(line(`  ${c.dim("↑↓ choose   enter use   esc back")}`));
      } else {
        lines.push(line(`  ${c.dim("↑↓ choose   enter next   esc close")}`));
      }
      lines.push(`${c.violet("╰")}${c.violet("─".repeat(innerWidth))}${c.violet("╯")}`);
      return lines;
    }

    renderModels(lines, line, innerWidth, visibleWidth, truncateToWidth) {
      if (catalog.length === 0) {
        lines.push(line(`  ${c.dim("No models are available.")}`));
        return;
      }

      const maxVisible = 7;
      const start = Math.max(0, Math.min(this.selectedIndex - 3, catalog.length - maxVisible));
      const end = Math.min(catalog.length, start + maxVisible);
      for (let index = start; index < end; index += 1) {
        const model = catalog[index];
        const selected = index === this.selectedIndex;
        const tail = model.id === currentModel ? "current" : providerLabel(model);
        const prefix = selected ? c.cyan("  ▸ ") : "    ";
        const tailWidth = visibleWidth(tail);
        const nameWidth = Math.max(8, innerWidth - 8 - tailWidth);
        const name = truncateToWidth(model.label || model.id, nameWidth, "…");
        const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(prefix) - visibleWidth(name) - tailWidth - 2));
        const row = `${prefix}${selected ? c.bold(name) : name}${gap}${c.dim(tail)}  `;
        lines.push(line(row, selected ? c.surfaceStrong : undefined));
      }
      if (catalog.length > maxVisible) lines.push(line(`  ${c.dim(`${this.selectedIndex + 1} / ${catalog.length}`)}`));
    }

    renderEfforts(lines, line) {
      const model = this.selectedModel();
      const levels = model ? modelEfforts(model) : [];
      const selectedEffort = this.selectedEffort();
      lines.push(line(`  ${c.dim("THINKING DEPTH")}`));
      for (const level of levels) {
        const selected = level === selectedEffort;
        const prefix = selected ? c.cyan("  ▸ ") : "    ";
        const hint = EFFORT_HINTS[level] || "";
        const row = `${prefix}${selected ? c.bold(level) : level}${" ".repeat(Math.max(1, 18 - level.length))}${c.dim(hint)}`;
        lines.push(line(row, selected ? c.surfaceStrong : undefined));
      }
    }
  }

  return new ModelEffortPicker();
}

module.exports = {
  DEFAULT_EFFORTS,
  closestEffort,
  createModelEffortPicker,
  modelEfforts,
  providerLabel,
};
