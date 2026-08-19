"use strict";

// A focused, combined model + reasoning selector for the terminal chat.
// chat.cjs owns effects (RPC and run state); this module owns navigation and
// presentation so both pieces stay small enough to understand independently.

const { c } = require("./ui.cjs");

const DEFAULT_EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]);

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
      const current = this.selectedEffort();
      const index = Math.max(0, levels.indexOf(current));
      this.effortByModel.set(model.id, levels[(index + delta + levels.length) % levels.length]);
      this.error = "";
      requestRender();
    }

    handleInput(data) {
      if (this.busy) return;
      if (matchesKey(data, "up")) this.moveModel(-1);
      else if (matchesKey(data, "down")) this.moveModel(1);
      else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) this.moveEffort(-1);
      else if (matchesKey(data, "right") || matchesKey(data, "tab")) this.moveEffort(1);
      else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) onCancel();
      else if (matchesKey(data, "enter")) {
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
      const lines = [
        `${c.violet("╭")}${c.violet("─".repeat(innerWidth))}${c.violet("╮")}`,
        line(`  ${c.violet("◆")} ${c.bold("MODEL + REASONING")}   ${c.dim("one choice, one place")}`, c.surface),
        divider(),
      ];

      if (catalog.length === 0) {
        lines.push(line(`  ${c.dim("No models are available.")}`));
      } else {
        const maxVisible = 7;
        const start = Math.max(0, Math.min(this.selectedIndex - 3, catalog.length - maxVisible));
        const end = Math.min(catalog.length, start + maxVisible);
        for (let index = start; index < end; index += 1) {
          const model = catalog[index];
          const selected = index === this.selectedIndex;
          const provider = providerLabel(model);
          const prefix = selected ? c.cyan("  ▸ ") : "    ";
          const providerWidth = visibleWidth(provider);
          const nameWidth = Math.max(8, innerWidth - 8 - providerWidth);
          const name = truncateToWidth(model.label || model.id, nameWidth, "…");
          const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(prefix) - visibleWidth(name) - providerWidth - 2));
          const row = `${prefix}${selected ? c.bold(name) : name}${gap}${c.dim(provider)}  `;
          lines.push(line(row, selected ? c.surfaceStrong : undefined));
        }
        if (catalog.length > maxVisible) {
          lines.push(line(`  ${c.dim(`${this.selectedIndex + 1} / ${catalog.length} models`)}`));
        }
      }

      lines.push(divider());
      const model = this.selectedModel();
      const levels = model ? modelEfforts(model) : [];
      const effort = this.selectedEffort();
      if (levels.length > 0) {
        const pills = levels.map((level) =>
          level === effort ? c.cyan(c.bold(` ${level} `)) : c.dim(` ${level} `),
        );
        lines.push(line(`  ${c.bold("Reasoning")}  ${pills.join(" ")}`));
      } else {
        lines.push(line(`  ${c.bold("Reasoning")}  ${c.dim("fixed by this model")}`));
      }
      lines.push(line(""));
      if (this.error) lines.push(line(`  ${c.red(truncateToWidth(this.error, Math.max(1, innerWidth - 4), "…"))}`));
      else if (this.busy) lines.push(line(`  ${c.cyan("✦ Applying model and reasoning…")}`));
      else lines.push(line(`  ${c.dim("↑↓ model   ←→ effort   enter apply   esc close")}`));
      lines.push(`${c.violet("╰")}${c.violet("─".repeat(innerWidth))}${c.violet("╯")}`);
      return lines;
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
