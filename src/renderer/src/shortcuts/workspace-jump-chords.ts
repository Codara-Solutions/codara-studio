import type { Chord } from "./chord";

// Default chords for the jump palette and the workspace navigation commands.
// They differ per platform because each OS reserves different keys, so they
// are pure functions of `isMac` (commands.ts passes IS_MAC) and the unit
// suite can check both sets in one process:
//
// - Jump palette: Cmd+J on macOS. Ctrl+J is a line feed in every terminal
//   (Claude Code and Pi read it as "new line"), so Windows and Linux take
//   Ctrl+Shift+J, which no shell, editor keymap or Electron menu uses.
// - Workspace 1 to 9: Mod+1..9 already switches tabs. macOS takes Ctrl+1..9
//   (Cmd+Shift+3/4/5 are the system screenshot keys). Windows and Linux take
//   Alt+1..9: Ctrl+Alt is AltGr on Windows, which types @, # and | on
//   Spanish, German and French layouts.
// - Back and forward: Cmd+Option+Left/Right on macOS (free in CodeMirror,
//   the terminal and the system). Ctrl+Alt+Left/Right switches virtual
//   desktops on GNOME, Cinnamon and Xfce, Alt+Left/Right moves by word in
//   the terminal and the editor, and Ctrl+[ is Escape in a terminal, so
//   Windows and Linux take Alt+[ and Alt+].

function chord(key: string, mods: Partial<Omit<Chord, "key">>): Chord {
  return {
    ctrl: mods.ctrl ?? false,
    meta: mods.meta ?? false,
    alt: mods.alt ?? false,
    shift: mods.shift ?? false,
    key,
  };
}

export function jumpPaletteDefaultChord(isMac: boolean): Chord {
  return isMac ? chord("j", { meta: true }) : chord("j", { ctrl: true, shift: true });
}

/** The representative chord of the 1 to 9 range: its modifiers with key "1". */
export function workspaceIndexDefaultChord(isMac: boolean): Chord {
  return isMac ? chord("1", { ctrl: true }) : chord("1", { alt: true });
}

export function workspaceBackDefaultChord(isMac: boolean): Chord {
  return isMac ? chord("ArrowLeft", { meta: true, alt: true }) : chord("[", { alt: true });
}

export function workspaceForwardDefaultChord(isMac: boolean): Chord {
  return isMac ? chord("ArrowRight", { meta: true, alt: true }) : chord("]", { alt: true });
}
