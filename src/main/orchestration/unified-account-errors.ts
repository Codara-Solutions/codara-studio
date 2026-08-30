import type { PiAccountProfile } from "./pi-account-profiles";

/** Sessions of the CLI are running and the caller did not agree to close them. */
export class UnifiedAccountSessionsError extends Error {
  readonly sessionCount: number;

  constructor(sessionCount: number, action: "delete" | "switch" = "delete") {
    super(
      `${sessionCount} terminal ${sessionCount === 1 ? "session is" : "sessions are"} using this account. Close ${sessionCount === 1 ? "it" : "them"} to ${action === "delete" ? "delete the account" : "switch accounts"}.`,
    );
    this.name = "UnifiedAccountSessionsError";
    this.sessionCount = sessionCount;
  }
}

export class UnifiedAccountNotConnectedError extends Error {
  constructor(profile: Pick<PiAccountProfile, "id" | "label">, cliLabel: string) {
    // The label is what the card shows; a row uuid tells the user nothing.
    super(`Neither Cora nor ${cliLabel} is signed in to ${profile.label}. Reconnect it first.`);
    this.name = "UnifiedAccountNotConnectedError";
  }
}
