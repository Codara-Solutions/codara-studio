// Row actions shared by the Sessions view and the transcript dialog. Each
// resolves to the short line the caller shows as feedback.

export async function copySessionId(sessionId: string): Promise<string> {
  try {
    await window.spark.clipboard.writeText(sessionId);
    return "Session id copied";
  } catch {
    return "Could not copy the session id";
  }
}

export async function revealSessionTranscript(sessionKey: string): Promise<string> {
  try {
    return (await window.spark.sessionSearch.reveal(sessionKey))
      ? "Transcript shown in its folder"
      : "The transcript file is gone from this computer";
  } catch {
    return "Could not show the transcript";
  }
}
