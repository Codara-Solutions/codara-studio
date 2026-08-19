"use strict";

// Pi owns text editing and the suggestion list. This small adapter gives slash
// commands Grok's completion contract: navigation changes only the ghost text;
// Space or Enter accepts the selected command without executing it.

const FAKE_CURSOR = "\x1b[7m \x1b[0m";

function slashGhostSuffix(prefix, selectedValue) {
  if (typeof prefix !== "string" || !/^\/[^\s]*$/u.test(prefix)) return "";
  const typed = prefix.slice(1);
  const selected = String(selectedValue ?? "");
  return selected.toLowerCase().startsWith(typed.toLowerCase())
    ? selected.slice(typed.length)
    : "";
}

function replaceCursorWithGhost(line, suffix, style, maxWidth, visibleWidth, truncateToWidth) {
  if (!suffix || !line.includes(FAKE_CURSOR)) return line;
  const cursorEnd = line.indexOf(FAKE_CURSOR) + FAKE_CURSOR.length;
  const tail = line.slice(cursorEnd);
  const replaceablePadding = tail.match(/^ */u)?.[0].length ?? 0;
  const room = Math.min(maxWidth, replaceablePadding);
  const ghost = truncateToWidth(suffix, room, "");
  if (!ghost) return line;

  const paddingToReplace = Math.min(visibleWidth(ghost), replaceablePadding);
  return `${line.slice(0, cursorEnd)}${style(ghost)}${tail.slice(paddingToReplace)}`;
}

function createCommandEditor({ Editor, matchesKey, visibleWidth, truncateToWidth, ghostStyle }) {
  return class CommandEditor extends Editor {
    slashSelection() {
      if (
        !this.autocompleteState ||
        !this.autocompleteList ||
        !this.autocompleteProvider ||
        !/^\/[^\s]*$/u.test(this.autocompletePrefix)
      ) {
        return null;
      }
      return this.autocompleteList.getSelectedItem();
    }

    acceptSlashSelection() {
      const selected = this.slashSelection();
      if (!selected) return false;

      this.pushUndoSnapshot();
      this.lastAction = null;
      const result = this.autocompleteProvider.applyCompletion(
        this.state.lines,
        this.state.cursorLine,
        this.state.cursorCol,
        selected,
        this.autocompletePrefix,
      );
      this.state.lines = result.lines;
      this.state.cursorLine = result.cursorLine;
      this.setCursorCol(result.cursorCol);
      this.cancelAutocomplete();
      this.onChange?.(this.getText());
      this.tui.requestRender();
      return true;
    }

    handleInput(data) {
      if (
        this.slashSelection() &&
        (matchesKey(data, "enter") || matchesKey(data, "space"))
      ) {
        this.acceptSlashSelection();
        return;
      }
      super.handleInput(data);
    }

    render(width) {
      const lines = super.render(width);
      const selected = this.slashSelection();
      const cursor = this.getCursor();
      const editorLines = this.getLines();
      if (!selected || cursor.line !== 0 || cursor.col !== (editorLines[0]?.length ?? 0)) {
        return lines;
      }

      const suffix = slashGhostSuffix(this.autocompletePrefix, selected.value);
      const cursorLine = lines.findIndex((line) => line.includes(FAKE_CURSOR));
      if (!suffix || cursorLine < 0) return lines;
      lines[cursorLine] = replaceCursorWithGhost(
        lines[cursorLine],
        suffix,
        ghostStyle,
        width,
        visibleWidth,
        truncateToWidth,
      );
      return lines;
    }
  };
}

module.exports = {
  createCommandEditor,
  replaceCursorWithGhost,
  slashGhostSuffix,
};
