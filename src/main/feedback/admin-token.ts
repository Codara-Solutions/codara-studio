// The feedback admin token: CODARA_FEEDBACK_ADMIN_TOKEN when set, else the
// one saved in Settings, About, kept in feedback.json encrypted with the
// operating system's keyring (Electron safeStorage). Without a keyring it is
// not saved at all, never in plain text. The token never goes to the
// renderer, a log line or a tool result: the renderer only learns its state.

import { safeStorage } from "electron";
import type { FeedbackAdminTokenState } from "@shared/feedback";
import { ADMIN_TOKEN_PATTERN, FEEDBACK_ADMIN_TOKEN_ENV } from "./admin";
import { feedbackStore } from "./service";

// With CODARA_DISABLE_KEYCHAIN=1 (tests) the keyring is never touched.
function keyring(): typeof safeStorage | null {
  if (process.env.CODARA_DISABLE_KEYCHAIN === "1") return null;
  try {
    return safeStorage?.isEncryptionAvailable() ? safeStorage : null;
  } catch {
    return null;
  }
}

function envToken(): string | null {
  const value = (process.env[FEEDBACK_ADMIN_TOKEN_ENV] ?? "").trim();
  return value && ADMIN_TOKEN_PATTERN.test(value) ? value : null;
}

async function savedToken(): Promise<string | null> {
  const encoded = (await feedbackStore().read()).adminToken;
  const encryption = keyring();
  if (typeof encoded !== "string" || !encryption) return null;
  try {
    const token = encryption.decryptString(Buffer.from(encoded, "base64"));
    return ADMIN_TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

export async function feedbackAdminToken(): Promise<string | null> {
  return envToken() ?? (await savedToken());
}

export async function feedbackAdminTokenState(): Promise<FeedbackAdminTokenState> {
  return {
    source: envToken() ? "env" : (await savedToken()) ? "saved" : "none",
    canSave: keyring() !== null,
  };
}

export async function saveFeedbackAdminToken(raw: unknown): Promise<{ ok: true; state: FeedbackAdminTokenState } | { ok: false; message: string }> {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!ADMIN_TOKEN_PATTERN.test(token)) return { ok: false, message: "That does not look like an admin token: 16 to 512 characters, no spaces." };
  const encryption = keyring();
  if (!encryption) return { ok: false, message: "This system has no keyring to encrypt the token, so it cannot be saved. Set CODARA_FEEDBACK_ADMIN_TOKEN instead." };
  let encoded: string;
  try {
    const encrypted = encryption.encryptString(token);
    // A keyring that cannot read its own output would lose the token.
    if (encryption.decryptString(encrypted) !== token) throw new Error("round trip");
    encoded = encrypted.toString("base64");
  } catch {
    return { ok: false, message: "The keyring could not encrypt the token, so it was not saved." };
  }
  await feedbackStore().update({ adminToken: encoded });
  return { ok: true, state: await feedbackAdminTokenState() };
}

export async function removeFeedbackAdminToken(): Promise<FeedbackAdminTokenState> {
  await feedbackStore().update({ adminToken: undefined });
  return feedbackAdminTokenState();
}
