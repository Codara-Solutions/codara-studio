import type { PaneNode, Tab, TerminalAgentSession, TerminalLeaf } from "./types";

// What the model / effort chords act on, resolved from the active tab.
//
// A Cora chat owns real model + effort state (RunState.chatModel/chatEffort),
// so it routes to the composer's own pill handlers. A terminal pane only
// qualifies while a CLI agent is actually LIVE in it: `/model` typed at a
// plain shell is just a failed command, and swallowing Ctrl+M (ASCII CR) or
// Ctrl+N (readline next-history) over an ordinary prompt would break the
// terminal for no gain. Everything else is "none", where the chord explains
// itself instead of acting.
//
// Kept out of App.tsx so the routing rules are unit-testable without booting
// the workbench.
export type AgentChordTarget =
  | { kind: "chat" }
  | { kind: "terminal"; paneId: string; runtime: TerminalAgentSession["runtime"] }
  | { kind: "none" };

function findLeaf(node: PaneNode, paneId: string): TerminalLeaf | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findLeaf(node.a, paneId) ?? findLeaf(node.b, paneId);
}

export function resolveAgentChordTarget(
  tabs: Tab[],
  activeTabId: string | null,
): AgentChordTarget {
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (!active) return { kind: "none" };
  if (active.kind === "chat") return { kind: "chat" };
  if (active.kind === "terminal") {
    const leaf = findLeaf(active.root, active.activePaneId);
    // `active` is the field the runtime detector sets and clears as the CLI
    // comes and goes; a stale session pointer left on a pane whose agent has
    // exited must read as a plain terminal.
    if (leaf?.agentSession?.active === true) {
      return {
        kind: "terminal",
        paneId: leaf.paneId,
        runtime: leaf.agentSession.runtime,
      };
    }
  }
  return { kind: "none" };
}
