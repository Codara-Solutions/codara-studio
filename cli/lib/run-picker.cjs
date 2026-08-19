"use strict";

// Current-project chat picker used by /resume. Effects stay in chat.cjs; this
// component only owns keyboard navigation and the compact overlay rendering.

const { c, timeAgo } = require("./ui.cjs");

function createRunPicker({ runs, currentRunId, onApply, onCancel, onCopy, onDelete, requestRender, ui }) {
  const catalog = Array.isArray(runs) ? [...runs] : [];
  const { matchesKey, truncateToWidth, visibleWidth } = ui;

  class RunPicker {
    constructor() {
      this.selectedIndex = Math.max(0, catalog.findIndex((run) => run.id === currentRunId));
      this.busy = false;
      this.busyLabel = "";
      this.confirmDeleteId = null;
      this.error = "";
      this.notice = "";
    }

    invalidate() {}

    move(delta) {
      if (catalog.length === 0) return;
      this.selectedIndex = (this.selectedIndex + delta + catalog.length) % catalog.length;
      this.confirmDeleteId = null;
      this.error = "";
      this.notice = "";
      requestRender();
    }

    selectedRun() {
      return catalog[this.selectedIndex];
    }

    runAction(label, action, onSuccess) {
      this.busy = true;
      this.busyLabel = label;
      this.error = "";
      this.notice = "";
      requestRender();
      let result;
      try {
        result = action();
      } catch (error) {
        this.busy = false;
        this.error = error instanceof Error ? error.message : String(error);
        requestRender();
        return;
      }
      Promise.resolve(result).then(onSuccess).catch((error) => {
        this.busy = false;
        this.error = error instanceof Error ? error.message : String(error);
        requestRender();
      });
    }

    copySelected() {
      const selected = this.selectedRun();
      if (!selected || !onCopy) return;
      this.runAction("Copying run id…", () => onCopy(selected), () => {
        this.busy = false;
        this.notice = `Copied ${selected.id}`;
        requestRender();
      });
    }

    deleteSelected() {
      const selected = this.selectedRun();
      if (!selected || !onDelete) return;
      if (this.confirmDeleteId !== selected.id) {
        this.confirmDeleteId = selected.id;
        this.error = "";
        this.notice = "";
        requestRender();
        return;
      }
      this.runAction("Deleting chat…", () => onDelete(selected), () => {
        const deletedIndex = catalog.findIndex((run) => run.id === selected.id);
        if (deletedIndex >= 0) catalog.splice(deletedIndex, 1);
        this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, catalog.length - 1));
        this.busy = false;
        this.confirmDeleteId = null;
        this.notice = `Deleted ${selected.title || selected.id}`;
        requestRender();
      });
    }

    handleInput(data) {
      if (this.busy) return;
      if (this.confirmDeleteId) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
          this.confirmDeleteId = null;
          requestRender();
        } else if (matchesKey(data, "d") || matchesKey(data, "delete")) {
          this.deleteSelected();
        }
        return;
      }
      if (matchesKey(data, "up")) this.move(-1);
      else if (matchesKey(data, "down")) this.move(1);
      else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) onCancel();
      else if (matchesKey(data, "c")) this.copySelected();
      else if (matchesKey(data, "d") || matchesKey(data, "delete")) this.deleteSelected();
      else if (matchesKey(data, "enter") && this.selectedRun()) {
        const selected = this.selectedRun();
        this.runAction("Opening chat…", () => onApply(selected), () => {});
      }
    }

    render(width) {
      const innerWidth = Math.max(1, width - 2);
      const line = (content = "", style) => {
        const clipped = truncateToWidth(content, innerWidth, "");
        const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
        return `${c.violet("│")}${style ? style(padded) : padded}${c.violet("│")}`;
      };
      const divider = `${c.violet("├")}${c.violet("─".repeat(innerWidth))}${c.violet("┤")}`;
      const lines = [
        `${c.violet("╭")}${c.violet("─".repeat(innerWidth))}${c.violet("╮")}`,
        line(`  ${c.violet("◆")} ${c.bold("RESUME CHAT")}   ${c.dim(`${catalog.length} in this project`)}`, c.surface),
        divider,
      ];

      if (catalog.length === 0) {
        lines.push(line(`  ${c.dim("No Cora chats in this directory yet.")}`));
      } else {
        const maxVisible = 9;
        const start = Math.max(0, Math.min(this.selectedIndex - 4, catalog.length - maxVisible));
        const end = Math.min(catalog.length, start + maxVisible);
        for (let index = start; index < end; index += 1) {
          const run = catalog[index];
          const selected = index === this.selectedIndex;
          const prefix = selected ? c.cyan("  ▸ ") : "    ";
          const meta = `${run.status} · ${timeAgo(run.updatedAt) || run.id.slice(0, 12)}`;
          const titleWidth = Math.max(8, innerWidth - visibleWidth(prefix) - visibleWidth(meta) - 3);
          const title = truncateToWidth(run.title || "Untitled chat", titleWidth, "…");
          const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(prefix) - visibleWidth(title) - visibleWidth(meta) - 2));
          lines.push(line(`${prefix}${selected ? c.bold(title) : title}${gap}${c.dim(meta)}  `, selected ? c.surfaceStrong : undefined));
        }
        if (catalog.length > maxVisible) {
          lines.push(line(`  ${c.dim(`${this.selectedIndex + 1} / ${catalog.length} chats`)}`));
        }
      }

      lines.push(divider);
      if (this.error) lines.push(line(`  ${c.red(truncateToWidth(this.error, innerWidth - 4, "…"))}`));
      else if (this.busy) lines.push(line(`  ${c.cyan(`✦ ${this.busyLabel}`)}`));
      else if (this.confirmDeleteId) {
        lines.push(line(`  ${c.red("Delete this chat permanently?")}  ${c.bold("d again")} confirm   esc keep`));
      } else if (this.notice) {
        lines.push(line(`  ${c.green("✓")} ${truncateToWidth(this.notice, innerWidth - 5, "…")}`));
      } else {
        lines.push(line(`  ${c.dim("↑↓ choose   enter resume   c copy id   d delete   esc close")}`));
      }
      lines.push(`${c.violet("╰")}${c.violet("─".repeat(innerWidth))}${c.violet("╯")}`);
      return lines;
    }
  }

  return new RunPicker();
}

module.exports = { createRunPicker };
