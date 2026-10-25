// ssh2 ships no declarations for its protocol constants. Only the list the
// host-key ordering reads is declared (connections.ts).

declare module "ssh2/lib/protocol/constants.js" {
  /** The server host key algorithms this ssh2 offers by default, all supported here. */
  export const DEFAULT_SERVER_HOST_KEY: readonly string[];
}
