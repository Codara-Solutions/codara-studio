/**
 * Renderer-facing view of the "use the Active account in your terminal"
 * setting. Deliberately carries no account directory, account id, or
 * credential — only the user's own shell file, Codara's pointer directory, and
 * the exact text the button would add.
 */
export interface NativeCliTerminalSetupStatus {
  /** False on Windows and for shells Codara will not edit automatically. */
  supported: boolean;
  installed: boolean;
  shell?: "zsh" | "bash";
  /** The user's own startup file, e.g. ~/.zshrc. */
  profilePath?: string;
  /** Codara's own pointer directory; contains no account name or id. */
  pointerDirectory: string;
  /** Exact block the button would add, shown before the user consents. */
  snippet: string;
  manualInstruction?: string;
  /** Set when the pointers themselves could not be written. */
  error?: string;
}

export type NativeCliTerminalSetupResult =
  | { ok: true; status: NativeCliTerminalSetupStatus }
  | { ok: false; status: NativeCliTerminalSetupStatus; error: string };
