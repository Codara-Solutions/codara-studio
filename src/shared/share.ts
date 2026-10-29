// Share as link: types shared by main (signing, upload, local records), the
// preload bridge and the renderer (Share popover, Settings "Shared pages").
// The share key itself never appears here: it stays in main.

import { isSecretFilePath } from "./secret-files";

export const SHARE_EXPIRY_CHOICES = [7, 30, 90] as const;
export type ShareExpiryDays = (typeof SHARE_EXPIRY_CHOICES)[number];
export const SHARE_DEFAULT_EXPIRY_DAYS: ShareExpiryDays = 30;

// The service's page cap. Studio checks it before asking, so the user hears
// about a page that is too large before anything is sent.
export const SHARE_MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const SHARE_MAX_TITLE_CHARS = 200;

export const SHARE_PAGE_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export type ShareableKind = "html" | "markdown";

export interface SharedPage {
  id: string;
  url: string;
  /** The file name it was shared from; kept on this computer only. */
  title: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

export interface SharedPagesList {
  pages: SharedPage[];
  /** True when the service could not be reached and the list is this computer's copy. */
  offline: boolean;
  error?: string;
}

export interface ShareCreateInput {
  html: string;
  title: string;
  ttlDays: ShareExpiryDays;
}

/** An agent asked Studio to offer sharing a file. Nothing is uploaded until the user confirms. */
export interface ShareOffer {
  path: string;
}

export function isShareExpiryDays(value: unknown): value is ShareExpiryDays {
  return (SHARE_EXPIRY_CHOICES as readonly unknown[]).includes(value);
}

export function shareableKind(path: string): ShareableKind | null {
  // A .env or key file never becomes a page, whatever its last extension
  // (.env.backup.html).
  if (isSecretFilePath(path)) return null;
  if (/\.(html?|xhtml)$/i.test(path)) return "html";
  if (/\.(md|markdown|mdown|mkd|mkdn)$/i.test(path)) return "markdown";
  return null;
}

export function formatShareBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
