// Which Antigravity conversations open panes name, for code that runs inside
// one pane (its restore) and cannot see the others. App publishes the layouts
// while it renders, before any pane mounts.

import type { Tab } from "../tabs/types";
import { antigravityConversationsNamed } from "./session-resume";

let layoutsSource: () => readonly { tabs: readonly Tab[] }[] = () => [];

export function publishAntigravityLayouts(source: () => readonly { tabs: readonly Tab[] }[]): void {
  layoutsSource = source;
}

export function antigravityConversationsNamedElsewhere(paneId: string): string[] {
  return antigravityConversationsNamed(layoutsSource(), paneId);
}
