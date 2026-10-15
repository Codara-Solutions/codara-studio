/**
 * What Settings shows about "plain `claude` in other terminals uses the
 * active account" (src/main/claude-follow). No account, path of Codara's
 * own folder or token: only the user's startup files, with the home folder
 * written as ~.
 */
export interface ClaudeFollowStatus {
  /** The setting (on by default). */
  enabled: boolean;
  /**
   * This copy of Codara can set it up: an installed app, not a development
   * build, a test run or an app started from its disk image.
   */
  available: boolean;
  /** The startup files that carry Codara's line, e.g. ~/.zshrc. */
  files: string[];
  /** Windows: Command Prompt has no startup file and keeps the user's own login. */
  windows: boolean;
}
