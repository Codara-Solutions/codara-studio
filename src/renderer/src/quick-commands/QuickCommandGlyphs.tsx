import type { QuickCommand } from "@shared/quick-commands";
import { runtimeLabel } from "../routing/agent-destinations";

// Small line glyphs for the quick command surfaces, drawn in currentColor so
// they follow the theme, and the words each row uses for its target.

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function PlayGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
    </svg>
  );
}

export function ShellGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M5 8l4 4-4 4" />
      <path d="M12 17h7" />
    </svg>
  );
}

export function PromptGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V8A1.5 1.5 0 0 1 5 6.5z" />
    </svg>
  );
}

export function PencilGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M15.5 5.5l3 3L9 18l-4 1 1-4z" />
    </svg>
  );
}

export function ArrowGlyph({ size = 12, down = false }: { size?: number; down?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} style={down ? { transform: "rotate(180deg)" } : undefined}>
      <path d="M12 18V6M7 11l5-5 5 5" />
    </svg>
  );
}

export function TrashGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
    </svg>
  );
}

export function KindGlyph({ command, size }: { command: QuickCommand; size?: number }) {
  return command.kind === "prompt" ? <PromptGlyph size={size} /> : <ShellGlyph size={size} />;
}

/** Where the command goes, in the words a menu row shows beside its name. */
export function quickCommandTargetLabel(command: QuickCommand): string {
  if (command.kind === "shell") return command.target === "new" ? "New terminal" : "Focused terminal";
  if (command.target === "cora") return "Cora";
  if (command.target === "new") return `New ${runtimeLabel(command.agent) ?? command.agent}`;
  return "Focused agent";
}
