# Agent session search

Codara keeps a local index of what you and your agents said in past Claude
Code, Codex, Grok, Pi and Cora sessions, so you can find a conversation by
its words and pick it up where it stopped. The code is in
`src/main/session-search/` (the index and its thread), the renderer side in
`src/renderer/src/components/session-search/`, and the types both share in
`src/shared/session-search.ts`.

## Finding a session

Open **Sessions** in the switch at the top of the rail's Workspaces section
(next to **Workspaces** and **Agents**). With the search box empty it lists
the most recent sessions; type to search. Each row shows the session's title
(the name you or the agent gave it, else its first prompt), the best
matching excerpt with your words highlighted, the agent, how many messages
it has and how long ago it was last used.

- **Workspace**, **Project** and **All** choose where to look: the current
  workspace's folder, every worktree of its repository (worktrees Codara
  removed included), or every session on this computer.
- **All agents** narrows the list to some agents.
- The refresh button reads new sessions now. Opening the view does the same
  when the index is more than a minute old.
- Up and Down move between the box and the rows; Enter in the box opens the
  first row.

You can also search from the jump palette: type anything and pick **Search
agent sessions for "..."**. The Sessions view opens on that text, searching
every session.

Clicking a row resumes the session in a new terminal tab, with the agent's
own resume command (`claude --resume <id>`, `codex resume <id>`,
`grok --resume <id>`, `pi --session <id>`), in the workspace whose folder
the session ran in. When no workspace has that folder, the deepest workspace
holding it is used, and when none does, the folder is added as a new
workspace. A Cora session opens its chat. A session already running in a pane
is gone to instead, because two agents on one transcript would corrupt it.

When a session's folder is no longer on the computer, it cannot be resumed:
the row says **folder gone**, and clicking it opens its transcript, read
only. The **...** menu on each row also has **View transcript**, **Copy
session id** and **Reveal transcript** (shows the transcript file in your
file manager).

## The session picker

**Resume a session...** in the tab strip's + menu, or Mod+Shift+H, opens the
picker: the list on the left, and on the right the highlighted session's
agent, model, folder, branch, length and the end of its conversation. Clicking
a worker in the + menu still starts a new session straight away.

One box searches session names, what you typed and what the agent replied.
Each result says which of those matched (**Name**, **You** or the agent's
name), with the matching words highlighted. With the box empty, sessions are
grouped as Pinned, Today, Yesterday, This week and Older.

| Key | Does |
|---|---|
| Up, Down, Page Up, Page Down | Move through the list |
| Enter | Resume, or go to its tab if it is running, or read it if its folder is gone |
| Alt+Enter | Fork: a new session from this one's history (Claude, Codex, Grok) |
| F2 | Rename; Enter saves, Escape cancels |
| Escape | Clears the box, then closes |

**Split here** resumes the session in a new pane beside the focused one, when
its folder belongs to the workspace on screen. The **...** menu pins, renames,
copies the id, reveals the transcript and deletes. Delete asks first, is only
offered for Claude, Codex and Grok sessions not running in a pane, and removes
the same files as Settings, Sessions. A session that list does not have (an
archived Codex session, one in another account's home) says it can't be deleted
from here before asking anything.

### Names and pins

A name is yours, not the agent's: it is stored in `session-labels.json` in the
Codara home, never written to a transcript, and the index reads it from there,
so it survives deleting or rebuilding the index. It shows wherever the session's
title does: the picker, the rail, the transcript view, Settings, the phone and a
tab opened by resuming it. Tabs already open keep their current title. Both the
name and the session's own title find the session. **Use original** clears the
name. Renaming a Cora chat renames the chat itself, with no separate name.

## What is indexed

Codara only reads the transcripts the CLIs already write, and never changes
them:

| Agent | Folder read |
|---|---|
| Claude Code | `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`), and Codara's own Claude account slot |
| Codex | `~/.codex/sessions/` and `~/.codex/archived_sessions/` (or `CODEX_HOME`) |
| Grok | `~/.grok/sessions/` (or `GROK_HOME`) |
| Pi | `~/.pi/agent/sessions/` |
| Cora | the chats in Codara's own `runs/` folder |

From each session it keeps the text of your messages and the agents'
replies, the title, the first prompt, the folder, the git branch when the
transcript records one (Claude Code always, Codex in newer sessions), the
agent, the model, the number of messages and when it started and was last used. It leaves out tool
calls and their output, reasoning, images, the context the CLIs inject
around a prompt, subagent threads, Codex exec runs, and any line longer than
1 MB. A folder reached through a link is read once, by its real path, and
copies of the same transcript in two homes count once.

The index is a SQLite file, `session-index/sessions.sqlite` in the Codara
home (mode 0600, see [on-your-machine.md](./on-your-machine.md)). It is a
cache: deleting it loses nothing but the time to build it again.

## How it stays out of the way

- It runs on its own thread with a capped heap, never on the main thread,
  and at the lowest scheduling priority on Linux.
- Transcripts are read in small chunks and only the prose is kept, so memory
  never holds a whole transcript. Each file remembers how far it was read;
  later passes read only what was appended, and a pass that is cut short
  continues where it stopped.
- Automatic passes work in short slices with rests between them, and wait
  while the computer is on battery or busy. The first build starts ten
  seconds after launch; after that, a pass runs a minute after launch and
  every ten minutes. A pass you start (opening the view, refresh) runs at
  once.
- The thread stops after three idle minutes.

On one developer machine (239 transcript files, 892 MB, giving 155 sessions
and 11,225 messages), the first build took 6.9 s at background pace (2.3 s
of CPU) and 2.6 s when started by hand, the measuring process peaked at
124 MB (47 MB before it started), the index came to 10 MB, searches
answered in 0 to 3 ms, and a pass with nothing new took 10 ms.
`scripts/profile-session-index.cjs` measures this on any computer without
touching its transcripts.

## The first build

The first time Codara finds agent sessions, it shows **Indexing your agent
sessions** with the build's progress ("172 of 172 sessions · 46K messages
searchable"). **Continue in background** closes it and lets the build go on
gently. It is shown once.

## Settings

Settings, Sessions, **Agent session search**:

- **Search agent sessions** turns indexing on or off. Off stops indexing and
  keeps the index until you delete it.
- **Agents to include**: sessions of agents left out are taken out of the
  index.
- **What agents can search**: what the `codara_session_search` tool may read
  (below).
- **Session index** shows how many sessions and messages it holds and its
  size on disk. **Rebuild index** reads everything again.
- **Delete session index**, the last row: **Delete index**, clicked twice,
  removes the file and turns search off, so it is not rebuilt.

## For agents

Agents Codara starts (terminal agents and Cora) get a read-only
`codara_session_search` tool in the `codara-studio` MCP server (see
[mcp-tools.md](./mcp-tools.md)). It searches the project of the workspace the
agent runs in, unless you chose **Every session** under **What agents can
search**, and answers with titles, session ids and excerpts of at most 240
characters. An agent never picks the workspace itself, and an imported pull
request's run cannot use it.
