// feedback.json in Studio's home: the anonymous install id the service rate
// limits by. It is a random UUID made the first time feedback is sent and
// kept from then on; nothing about the machine or the person goes into it.
// A Codara admin's token is kept here too, only ever encrypted by the
// system keyring (admin-token.ts).

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

export const FEEDBACK_FILE = "feedback.json";

const INSTALL_ID = /^[0-9A-Za-z_-]{8,64}$/;

export interface FeedbackFileData {
  installId?: string;
  /** safeStorage ciphertext, base64. Never the token itself. */
  adminToken?: string;
}

export interface FeedbackStoreDeps {
  file: string;
  write(file: string, text: string): Promise<void>;
}

export class FeedbackStore {
  private data: FeedbackFileData | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: FeedbackStoreDeps) {}

  async read(): Promise<FeedbackFileData> {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(await fs.readFile(this.deps.file, "utf8")) as unknown;
      this.data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as FeedbackFileData) : {};
    } catch {
      this.data = {};
    }
    return this.data;
  }

  // One id even when two reports start at once.
  installId(): Promise<string> {
    this.pendingId ??= (async () => {
      const data = await this.read();
      if (typeof data.installId === "string" && INSTALL_ID.test(data.installId)) return data.installId;
      const installId = randomUUID();
      // A disk that refuses the write still gets this id for the session.
      await this.save({ ...data, installId }).catch(() => undefined);
      return installId;
    })().finally(() => {
      this.pendingId = null;
    });
    return this.pendingId;
  }

  private pendingId: Promise<string> | null = null;

  /** Merges into the file; a field set to undefined is removed. */
  async update(patch: Partial<FeedbackFileData>): Promise<void> {
    await this.save({ ...(await this.read()), ...patch });
  }

  protected save(next: FeedbackFileData): Promise<void> {
    this.data = next;
    const write = this.writing.then(() => this.deps.write(this.deps.file, `${JSON.stringify(this.data, null, 2)}\n`));
    this.writing = write.catch(() => undefined);
    return write;
  }
}
