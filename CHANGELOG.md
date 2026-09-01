# Changelog

All notable changes to Codara Studio. Versions are the git tags the release pipeline creates from conventional commits; this file lists the feature and fix subjects between tags. Newer entries are added by hand at release time.

## v1.3.1 (2026-09-01)

### Fixed

- forgetting Account 1 actually removes the card

## v1.3.0 (2026-09-01)

### Added

- MCP servers are shared across Claude accounts

## v1.2.3 (2026-09-01)

### Fixed

- revealed panes repaint, agents survive a full-screen view
- a slot logged into another account is never adopted
- untracked directories list their files, never a nameless row

## v1.2.2 (2026-08-31)

### Fixed

- the fresher Claude credential store wins the read

## v1.2.1 (2026-08-30)

## v1.2.0 (2026-08-30)

### Added

- xterm.js 6, real pty backpressure, and a feel test
- running shells follow the active account through the prompt hooks
- one card model for every provider
- running shells follow the active account through a pointer file
- one migration runner and provider dispatch in the Pi flows
- codex adapter over the auth-only vault
- grok moves to the per-directory model
- codex and grok credential codecs
- one anthropic card
- unified anthropic account service and migration
- anthropic credential mirror

### Fixed

- onboarding seed reads the injected home, not os.homedir()
- an agent pane follows the Active account once the agent exits
- the account switch lands on the very next command
- the PowerShell hook reads the pointer without cmdlet error records
- the group detail says open terminals follow a switch
- pointer refreshes read the defaults inside the write serialization
- panes never inherit the follow flag or another app's home
- the external codex count skips Studio's own panes and runs off the main thread
- first launch keeps a managed CLI default the user chose
- cora-only rows switch and delete without a personal login
- the codex live slot never adopts a foreign login and a logout sticks
- codex vault re-seeds the personal backup after a fresh login
- settings cards settle, count, and report errors honestly
- route disconnect through the service and name both halves
- live-slot undo keeps the token, the identity, and its retry
- keep the personal login in the Keychain alone on macOS
- delete refuses before it moves and unlinks before it removes
- mirror refuses stale, unwatched, and orphaning writes
- reconcile after a terminal exit through the runtime hook
- delete still hands off when Account 1 is signed out everywhere
- reopen the OAuth page in the system browser, not in-app
- sign-in stall watchdog, no card pop-in; CI-safe test path
- red close either hides to background or truly quits
- accent foregrounds use the readable accent token
- drop em dashes from worker prompt and MCP tool descriptions
- commit and split share one half-width row

## v1.1.0 (2026-08-30)

### Added

- details popover on the update chip

### Fixed

- deleting the default CLI account hands default to personal
- drop unreachable idle comparison in the popover title

## v1.0.3 (2026-08-30)

### Fixed

- route the install through the quit cleanup pipeline

## v1.0.2 (2026-08-30)

### Fixed

- update chip moves to the status bar beside Workers

## v1.0.1 (2026-08-30)

## v1.0.0 (2026-08-30)

### Added

- semantic version bumps from conventional commits
- pass durations in history rows and the live hero clock
- remove old passes from an automation's history
- mini flow electricity tracks the running node
- accent-tinted Codara mark beside the titlebar wordmark
- mini terminal in the run peek with live step output
- price subscription usage at refreshed list rates, labeled as estimate
- steps-only passes run live, with streamed output
- build from a pristine git worktree, never the live tree
- surface the GitHub App install where git triggers live
- instant push detection via GitHub webhooks over the release SSE stream
- git and automation-activity trigger kinds
- copyable id chips on list rows and the detail header
- periodic checks, SSE release push, manual check in Settings
- macOS-style app icon tile with the correctly proportioned mark
- self-hosted update feed, signed+notarized builds, one-command releases
- order split commits by dependency and isolate hitchhiker fixes
- wire commit-splitting and share-for-review IPC plumbing
- replace publish-as-PR with a Share for review flow
- add split-into-commits dialog and planner
- show +added/−removed line counts and tree view for changes
- open commit-history file diffs as workbench tabs
- route full Cora worker roster for commit drafts
- manage Cora subscription and native CLI accounts together
- default toast duration 6 s
- configurable toast on-screen time
- step nodes , shell, scripts, HTTP, files, notify
- redesign the Cora Board kanban
- move user data to ~/.codarastudio and rename existing ~/.Codara
- background auto-fetch with teammate-push notifications
- improve PR review and session resilience
- add discard-all action and drop the row discard confirm step
- harden profiles, sessions, and account switching
- improve worker routing and session reliability
- add focus mode and Excel viewer
- refine agent session interactions
- measure worker edits outside git
- show each worker's measured file and line changes
- denser handoffs and an honest context meter
- one model + thinking control and a per-chat Cora profile

### Fixed

- bundle electron-updater; one-click update chip in the chrome
- draw the menu-bar icon from the bare transparent mark
- keep the strip chip a fixed Auto pill while running
- render streamed step output in the hero feed
- the board and hero tell the truth during a live steps-only pass
- dev builds hold the SSE stream too, for webhook-driven fetches
- steps-only passes are visible while running and afterwards
- source push alerts from GitHub, silence them, kill false alarms
- git trigger keeps a persisted baseline, catches up at arm
- legible stop-condition chips and a findable budget cap
- budgetUsd 0 means no cap, not instant budget-reached
- never auto-acknowledge a loom Notify step's alert
- route queued steering before posting the "nothing runnable" question
- restore remoteAccess:getStatus and sshKeys handlers
- make alerts traceable and drop two ghost "finished" triggers
- stop hiding tool-heavy Claude sessions from the picker
- follow CLAUDE_CONFIG_DIR everywhere Claude's config is read
- collapse the GitHub block until it is asked for
- report a failed manager turn as a failure, not a question
- stop settled runs from pinning a workspace attention dot
- preserve viewport through pane resizes
- preserve CLI sessions and bound renderer memory
- scope worker launches to their plus menu
- switch accounts without splitting state
- preserve tabs and terminal position
- fold an implicit resume into the message that caused it
- recognize Codara's own built-in TOML entry by its shape
- stop stuck Pi turns from outliving their run
- preserve exact workspace accents
- the mini-lang positions gate demanded an unstated message
- put toasts on the app's glass material
- a docked chat keeps its sub-navigation, and split cells all say what they are
- give a docked cell its own title strip, and let the chat lay out for it
- stop blank localhost tabs, and split any surface against the one on screen
- stop Claude sign-ins dying on a missing AbortSignal
- stop phone agent spawns dying in the renderer adapter gap
- give docked panes one real header instead of overlapping bars
- cache gh reads across the GitHub surface
- keep PR status readable on an older GitHub CLI
- don't steal focus from an open modal dialog
- stop dropping input sent before a pane's spawn lands
- put every glass surface on the one material the settings control
- make the crash screen readable, and its report copyable
- keep streamed turns visible after a parked retry
- undoing Resume parks the run instead of completing it
- do not revive a failed resume into autopilot
- treat Resume as a checkpointed user turn
- persist the Cora session id before the turn settles
- restore the context gauge after an interrupted turn
- ask matching choices when a plan cannot run
- say the chat title also appears in the panel header
- tell Cora that risk is not complexity
- risk is not complexity; approved apply is mechanical
- do not treat prose expectedOutputs as file paths
- keep the context gauge and persist the session mid-turn
- park expired credentials instead of failing the run
- detect live Codex and drop false needs-you
- dead pointer-events on freshly opened tabs; explorer + preview polish
- reply in the language of the user's latest message
- stabilize corrective runs and completion state

## v0.3.0 (2026-07-21)

### Added

- user-named branches replace parody copies

## v0.2.0 (2026-07-20)

### Added

- branch picker for Create copy
- add .docx preview support
- streamline Cora orchestration and workspace runtime
- merge preview + orchestrator into one codara-studio server; add agent terminal tools
- allow Fable 5 workers when the user explicitly asks
- remote agent detection + honest orchestration gating (phase 4)
- remote git and project search over SSH (phase 3)
- remote filesystem over SFTP (phase 2)
- SSH connections, host management and remote terminals (phase 1)
- diff tabs with hunk-level staging and explorer change decorations
- clipboard copy/cut/paste with Windows Explorer interop
- native previews for images, SVG, PDF and media files
- opt-in debounced autosave with disk-conflict guard
- workspace dots spin a comet ring while work runs inside
- reliable session restore , race-free resume, graceful quit, staggered warm-up
- parallel workers get per-node tool access, awareness, and a shared message board
- configuration section shows the real pipeline, node by node
- rail + stage redesign , armed/paused looms, one action bar, corner-safe board trigger
- each loom lists its own workers inside the detail view
- professional node design language, click-only LiveBoard, no auto/default workers, persistent automation notifications
- fresh assist sessions on entry, terminal view behind the architect chat, AI-named chats everywhere
- live whiteboard , a running loom shows its graph executing, workers docked inside the canvas
- architect chat sees only this workspace's looms; edits require linked user approval; AI-named chats with visible ids
- automations alert once at the real end, with their own visual identity
- reopen creator chat, fix worker terminal garble, grouped workers view with focus mode
- dragging workspace files onto a folder moves them instead of copying
- drop file paths into composer, Copy Path menu, visible preview-tab italics
- restore Claude/Codex terminal sessions on reopen
- fleet policy reaches live managers; stale Sonnet hints remapped at spawn
- parallel mixed-runtime worker fleets with peer/manager comms + personal-config shield
- Create with Cora , architect chat lives in the Automations tab
- Auto mode , Cora routes each message herself (new default)
- Fable 5 gated behind default-off 'Allow Fable 5' setting
- app display name is Codara Studio
- the app is Codara, the agent is Cora
- cora , a terminal remote for the running app + dev-gated app.* RPCs
- glass every floating menu/popover + user-tunable glass settings
- port the liquidglass-oss lens , see-through core, rim refraction
- make liquid glass actually read as glass
- identifier rebrand Phase B , com.codara.cora, ~/.Cora, cora-* MCP servers (with migrations)

### Fixed

- stop processed-hooks backfill from blocking first window
- show file listing for untracked directory diffs
- use pdfjs legacy build for Chromium 128 compat
- sleep/crash-resilient app recovery + session-registry resume fix
- arm the CLAUDE chip order-independently; the banner race, not CC output, broke it
- show the run inner strip only on the run's own tabs
- honor explicit Fable 5 worker requests in every manager mode
- never fail a live turn on transcript silence; detect dead sessions instead
- give tab labels their unfloored natural width so short titles stop ellipsizing
- route OSC 8 hyperlink clicks through openExternal instead of xterm's confirm()
- recognize Claude Code 2.1.204 permission-mode footers so the CLAUDE chip survives
- Cmd+C/X/V reach the tree in real-world focus states; paste needs no file selection
- macOS file-clipboard interop for copy/cut/paste
- stop CLAUDE working/ready chip flickering off a frozen footer
- session restore is boot-once and running-at-close only, Codex on equal footing
- hold 'done' while Claude background teammates still run
- stop ghost "finished" toasts from mid-turn output stalls
- watch-only worker terminals, terminals survive tab switches, downstream workers never run blind
- malformed persisted loom (loop without stop) can no longer kill the renderer
- stop surfacing update-feed failures as an error banner
- deterministic session capture at launch for Claude workers
- paused runs pull their loom out of Running; worker report survives instant CLI exit; corner-safe node top rules
- workers use Sonnet 5 (not stale 4.6) as mid-tier; silence GUEST_VIEW_MANAGER_CALL spam from preview probes
- worker TUIs no longer strand at stale/narrow width after hidden resizes
- keep ~/.claude/settings*.json readable , EPERM there re-arms the consent gate
- warm backend terminals survive workspace switches (sticky warm set)
- backend terminal survives view switches , persistent hoisted xterm
- in-app toast and native OS notification never fire together
- background-workspace run deletion can no longer restore stranded tabs
- run-owned preview can no longer strand as an uncloseable fullscreen browser
- composer input no longer collapses after being measured while hidden
- chat backend terminal no longer garbles on tab-switch remount
- truthful timing, press-to-remove center, reliable toast expiry
- survive Claude Code 2.1.201 , robust first-turn submission, truthful turn failures, env hygiene
- glass surfaces render instantly , no entry animation on lens carriers
- loom worker model dropdown also respects the Fable gate
- black pane after chat/terminal tab switches
- trust writer used lowercased backslash keys , codex never matched them
- adversary findings , agent-voice strings say Cora, inspect-run probes ~/.Codara
- evaluate returns the last expression's value as documented
- terminal workspace layer no longer swallows clicks on the chat surface
- search modals on standard material + adversary findings (backdrop roots)
- adversary findings , inner-strip fallback parity, lens region clamp
- adversary findings , hook home mismatch, MCP namespace mismatches, stripper data-loss
- surface prepareWorkerTask failures, reject count loops without a count, drop stale phase comment
- leave non-ASCII bare in POSIX path escaping, quote-wrap CR/LF paths
- image paste/drop lands as [Image #N] in agent TUIs
- chip running-state detection, notification dedup/tone, drag fixes
- bound hook-file processing concurrency; prune processed/
- make the fast-mode toggle's on-state visible
- wait for Codex TUI readiness before submitting the prompt
- Finish the Ctrl+K run switcher
- Wire the worker-sandbox merge-back
- Fix Codex/GPT error 193 (Windows shim spawn)
- Make Fan-out self-explanatory

