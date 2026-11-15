// window.spark.sessionRelay: the renderer side of src/main/session-relay/
// (messages an outside caller asked to send, waiting for the user's Send).

import { ipcRenderer } from "electron";

import type { PendingRelay, RelayDecision, RelayOutcome } from "@shared/session-relay";
import { subscribeSignal } from "../subscribe";

export interface RelayList {
  pending: PendingRelay[];
  /** How the relays that ended lately ended, by id. */
  outcomes: Record<string, RelayOutcome>;
}

export type RelayDecideReply =
  | { ok: true; outcome: RelayOutcome }
  | { ok: false; error: string; stillPending: boolean };

export const sessionRelayApi = {
  list: (): Promise<RelayList> => ipcRenderer.invoke("relay:list"),
  decide: (relayId: string, decision: RelayDecision): Promise<RelayDecideReply> =>
    ipcRenderer.invoke("relay:decide", relayId, decision),
  onChanged: subscribeSignal("relay:changed"),
};
