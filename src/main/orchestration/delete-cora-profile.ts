import type { CoraProfileDeleteResult } from "@shared/types";
import { deleteProfileMemoryState } from "./cora-memory";
import { DEFAULT_CORA_PROFILE_ID, deleteCoraProfile, listCoraProfiles, resolveCoraProfile } from "./cora-profiles";

export async function deleteCoraProfileWithChats(reference: string, deps: {
  reassignRuns(from: string, to: string): Promise<number>;
  trashItem(path: string): Promise<void>;
  expectedCreatedAt?: string;
}): Promise<CoraProfileDeleteResult> {
  const target = resolveCoraProfile(reference);
  if (target.id === DEFAULT_CORA_PROFILE_ID) {
    throw new Error("The built-in Cora profile cannot be deleted.");
  }
  if (deps.expectedCreatedAt !== undefined && target.createdAt !== deps.expectedCreatedAt) {
    throw new Error("This profile changed. Refresh before deleting it.");
  }
  const firstPass = await deps.reassignRuns(target.id, DEFAULT_CORA_PROFILE_ID);
  const deleted = await deleteCoraProfile(target.id, target.createdAt);
  // A run may start between the first pass and the registry commit. Once the
  // profile is no longer selectable, a second pass catches that last run.
  const secondPass = await deps.reassignRuns(target.id, DEFAULT_CORA_PROFILE_ID);
  await deleteProfileMemoryState(target.id);
  if (deleted.stagedDataPath) {
    try {
      await deps.trashItem(deleted.stagedDataPath);
    } catch (error) {
      // Preserve staged data for recovery if the OS cannot move it to Trash.
      console.warn("[cora-profiles] could not move deleted profile data to trash", error);
    }
  }
  return {
    profiles: listCoraProfiles(),
    deletedProfile: { id: deleted.profile.id, name: deleted.profile.name },
    reassignedRunCount: firstPass + secondPass,
  };
}
