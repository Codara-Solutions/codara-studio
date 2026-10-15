// Where a skill Codara installed came from, and whether its source has moved.
// The record lives in Codara's own folder (<codara home>/skill-origins), keyed
// by the skill's folder; nothing is written inside the skill itself.

export type SkillOriginKind = "git" | "folder" | "zip";

export interface SkillOrigin {
  kind: SkillOriginKind;
  // git: the https address that was cloned, the branch or tag asked for
  // (none: the repository's default branch), the default branch it resolved
  // to (display only), the commit installed, the skill's folder inside the
  // repository ("" for its root), and that folder's git tree, which tells a
  // repository that moved apart from a skill that changed.
  url?: string;
  ref?: string;
  branch?: string;
  commit?: string;
  subpath?: string;
  tree?: string;
  // folder and zip: where it was imported from.
  sourcePath?: string;
  installedAt: string;
  updatedAt?: string;
}

// "unchecked": never compared with its source, or the record has no source a
// check can reach (a folder or a zip).
export type SkillUpdateState = "unchecked" | "current" | "update-available" | "error";

export interface SkillOriginStatus {
  skillDir: string;
  name: string;
  origin: SkillOrigin;
  state: SkillUpdateState;
  // The commit the remote branch or tag pointed at when last checked.
  remoteCommit?: string;
  checkedAt?: string;
  error?: string;
  // The version the last update replaced, kept so it can be restored.
  rollback?: { savedAt: string; commit?: string };
}

export interface SkillUpdateResult {
  ok: boolean;
  // Skill folders whose files changed, and those already matching the source.
  updated: string[];
  unchanged: string[];
  errors: string[];
  origins: SkillOriginStatus[];
}

export interface SkillRollbackResult {
  ok: boolean;
  restored: string[];
  errors: string[];
  origins: SkillOriginStatus[];
}
