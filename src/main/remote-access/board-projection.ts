import { createHash } from "node:crypto";

import type { RemoteBoard } from "./rpc";

export interface RemoteBoardReadProjection {
  board: RemoteBoard;
  /** Digest of the exact bounded board projection sent to the phone. */
  revision: string;
}

/**
 * Adds a stable conditional-read token after the board has been card/byte
 * bounded. The board's numeric revision remains the compare-and-swap token
 * for mutations; this digest describes the exact mobile read projection.
 */
export function projectRemoteBoardRead(
  board: RemoteBoard,
): RemoteBoardReadProjection {
  return {
    board,
    revision: createHash("sha256")
      .update(JSON.stringify(board))
      .digest("base64url"),
  };
}
