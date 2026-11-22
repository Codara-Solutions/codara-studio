import { basename } from "../path-utils";
import type { DiffTab, Tab, TabId } from "./types";

/** The diff tab the chat's changed-file links last put a file in. */
export interface ChatDiffTab {
  id: TabId;
  path: string;
}

export interface DiffTabOpenPlan {
  tabs: Tab[];
  id: TabId;
  /** The chat's tab after this open: unchanged when undefined. */
  chat?: ChatDiffTab;
}

/**
 * Where a working-tree diff opens (useTabs.openDiffTab). Identity is
 * (path, staged): an open tab for it is focused. Otherwise the shared preview
 * slot swaps its file, else a new tab opens.
 *
 * `chat` is set for the chat's changed-file links, which share one tab: the
 * tab they last opened is reused only while it is still theirs (it shows the
 * file they put there, is a working-tree diff and is still a preview). A tab
 * the user pinned, docked into a split or moved to another file or commit is
 * the user's, and the chat never adopts a pinned tab it merely focused.
 */
export function planDiffTabOpen(
  curr: Tab[],
  path: string,
  staged: boolean,
  options: { pin?: boolean; chat?: ChatDiffTab | null; fromChat?: boolean },
  newId: () => TabId,
): DiffTabOpenPlan {
  const fromChat = options.fromChat === true;
  const remember = (id: TabId): ChatDiffTab | undefined => (fromChat ? { id, path } : undefined);
  const existing = curr.find(
    (t): t is DiffTab => t.kind === "diff" && !t.commitHash && t.path === path && t.staged === staged,
  );
  if (existing) {
    const tabs = options.pin && existing.preview
      ? curr.map((t) => (t.id === existing.id && t.kind === "diff" ? { ...t, preview: false } : t))
      : curr;
    const adoptable = existing.id === options.chat?.id || Boolean(existing.preview);
    return { tabs, id: existing.id, chat: adoptable ? remember(existing.id) : undefined };
  }
  const own = fromChat ? chatOwnedDiffTab(curr, options.chat) : undefined;
  // The chat's own tab first, then the shared preview slot (working-tree or
  // commit flavor): swap its payload instead of stacking a new pill per click.
  const reusable = own ?? curr.find((t): t is DiffTab => t.kind === "diff" && !t.review && Boolean(t.preview));
  if (reusable) {
    return {
      tabs: curr.map((t) =>
        t.id === reusable.id && t.kind === "diff"
          ? { ...t, title: basename(path), path, staged, commitHash: undefined, preview: !options.pin }
          : t,
      ),
      id: reusable.id,
      chat: remember(reusable.id),
    };
  }
  const id = newId();
  const tab: DiffTab = { id, kind: "diff", title: basename(path), path, staged, preview: !options.pin };
  return { tabs: [...curr, tab], id, chat: remember(id) };
}

/** The chat's tab, while it still shows what the chat put there. */
export function chatOwnedDiffTab(curr: readonly Tab[], chat: ChatDiffTab | null | undefined): DiffTab | undefined {
  if (!chat) return undefined;
  const tab = curr.find((t) => t.id === chat.id);
  if (!tab || tab.kind !== "diff" || tab.review || tab.commitHash || tab.staged || !tab.preview) return undefined;
  return tab.path === chat.path ? tab : undefined;
}
