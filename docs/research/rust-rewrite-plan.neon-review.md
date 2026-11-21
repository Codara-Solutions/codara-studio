# Second review: Rust rewrite plan

Reviewed against `docs/research/rust-rewrite-plan.md` (commit `864149d4`) and the live repository on 21 Nov 2026. Every outside link below was read on 21 Nov 2026.

## 1. Verdict in five lines

1. Do not follow this plan as written, even though its central instinct (Rust core first, measured gate before any UI rewrite) is right.
2. The single biggest thing to change is the core architecture: build `codara-core` as an out-of-process daemon from day one instead of a throwaway Node native addon that breaks the 466 `esbuild` unit suites and gets discarded in Wave 5.
3. The plan misreads its own recommended UI stack (`gpui-fast` already ships native window composition on Wayland, X11, macOS and Windows, yet turns off virtual-list scroll layers whenever accessibility is active) and misreads `ghia-bench` CPU/SoC energy as GPU energy.
4. It overstates the case for bundling CEF inside the app, misses hidden Chromium encoders (WebCodecs video and `OffscreenCanvas` WebP), and leaves out more than a dozen real subsystems, two local sockets, and the Linux Wayland software-rendering safety net.
5. Upgrade the spikes, fix CI for Windows and Linux, invert tab and browser state ownership out of React first, and ship the Rust daemon before deciding whether a native UI is worth building.

---

## 2. Where the plan is wrong or weak

### 2.1 Toolkit comparison and the GPUI Kit + GPUI Fast recommendation

**Sections:** `2.1`, `2.2`, `2.4`, `3.1`

**Why it is wrong or weak:**

- **It misses that `gpui-fast` already has Wayland window composition.** Sections `2.1` and `3.1` item 1 state that GPUI cannot embed native views on Wayland and cite `zed#62379` as an unmerged PR. Yet `gpui-fast`, the exact fork recommended in `2.4`, has already ported `zed#62379` and ships opt-in window composition on macOS (`WKWebView`), Windows (`WebView2`), Linux Wayland (`wl_subsurface` + overlay subsurfaces) and Linux X11.
- **It misses three scroll-layer caveats in `gpui-fast` that hit Studio directly.** First, `gpui-fast`'s scroll-layers doc states that virtual lists (`uniform_list` and `list`) draw **without** scroll layers whenever accessibility is active. That directly collides with Phase 3's AccessKit-based UI test driver and with any user running assistive tech or desktop tools that enable accessibility. Second, `gpui-fast` notes that GPUI Kit itself writes window-wide state during render (`sync_focused_input_registry`, `GlobalState`, `SelectionStateRegistry`), forcing ancestor rebuilds on every scrolled frame. Third, containers holding a focused input, deferred/anchored elements, or an active animation frame (such as a streaming spinner or blinking cursor) bypass scroll layers.
- **It underplays Linux Wayland GPU fragility.** Studio currently disables hardware acceleration **by default** on native Linux Wayland (`src/main/index.ts`, `src/shared/gpu-drawing.ts`) because Vulkan/Wayland surface teardown killed the whole Electron main process with a broken pipe. GPUI renders through `gpui_wgpu` inside the UI process and has no equivalent automatic software-compositor safety net.
- **It underplays the single-maintainer fork chain.** On crates.io, `gpui-pre`, `gpui-fast` and `gpui-kit` are all owned by one personal account (`huacnlee`). `gpui-fast`'s `compat/README.md` requires manual `[patch.crates-io]` entries pinned to the exact `gpui-pre` version (`=0.3.12`) that `gpui-kit` expects, while `gpui-fast/Cargo.toml` pulls git-pinned forks (`font-kit`, `wgpu`, `wasm_thread`) across 27 tracked Zed directories.
- **It marks Tauri 3 CEF issues as secondhand instead of citing live bugs.** Primary GitHub issues confirm open Linux blockers in `tauri-runtime-cef`: idle main thread spinning at 100% CPU (`#16189`), broken focus/keyboard input after window switching (`#16351`, `#16251`), SwiftShader-only WebGPU (`#16203`), and Linux `.deb` sidecar path failures (`#16577`).

**Evidence:**
- `gpui-fast` README and window composition implementation: [longbridge/gpui-fast README](https://github.com/longbridge/gpui-fast/blob/main/README.md), [composition.rs](https://github.com/longbridge/gpui-fast/blob/main/crates/gpui/src/fast/composition.rs) (read 21 Nov 2026).
- `gpui-fast` scroll-layer fallbacks and GPUI Kit render-state note: [docs/scroll-layers.md](https://github.com/longbridge/gpui-fast/blob/main/docs/scroll-layers.md) (read 21 Nov 2026).
- `gpui-fast` compatibility setup and tracked Zed crates: [compat/README.md](https://github.com/longbridge/gpui-fast/blob/main/compat/README.md), [UPSTREAM](https://github.com/longbridge/gpui-fast/blob/main/UPSTREAM), [Cargo.toml](https://github.com/longbridge/gpui-fast/blob/main/Cargo.toml) (read 21 Nov 2026).
- Single crates.io owner across all three crates: [gpui-pre owners](https://crates.io/api/v1/crates/gpui-pre/owners), [gpui-fast owners](https://crates.io/api/v1/crates/gpui-fast/owners), [gpui-kit owners](https://crates.io/api/v1/crates/gpui-kit/owners) (read 21 Nov 2026).
- Wayland software-default safety net in this repo: `src/main/index.ts` (lines 155 to 238), `src/shared/gpu-drawing.ts`, `src/main/gpu-drawing.ts`.
- Tauri 3 CEF bugs: [tauri#16189](https://github.com/tauri-apps/tauri/issues/16189), [tauri#16203](https://github.com/tauri-apps/tauri/issues/16203), [tauri#16351](https://github.com/tauri-apps/tauri/issues/16351), [tauri#16577](https://github.com/tauri-apps/tauri/issues/16577) (read 21 Nov 2026).

**What to write instead:**
Acknowledge that `gpui-fast` already implements Wayland/X11/macOS/Windows native surface composition, then put its three real risks front and center: virtual-list scroll layers disable under AccessKit, GPUI Kit's global render state weakens retained mode, and GPUI lacks Studio's Wayland software-rendering safety net. Treat GPUI + GPUI Kit + GPUI Fast as a conditional candidate gated on an AccessKit-on, streaming-plus-scroll Wayland spike, not a solved widget kit.

---

### 2.2 The scrolling cost claim and benchmark interpretation

**Sections:** `2.3`, `6.2`

**Why it is wrong or weak:**

- **It misreads `ghia-bench`'s `Energy (mJ)` metric as including GPU work.** Section `2.3` says: "Energy includes the graphics card's work." That is wrong. `ghia-bench` reads `ri_energy_nj` from macOS `proc_pid_rusage(RUSAGE_INFO_V6)` (`Sample.swift`), which is per-process CPU/SoC energy. GPU time is collected separately from IOKit `IOAccelerator` `AppUsage` (`Gpu.swift`) and is absent from the published `2026-11-05-no-capture` summary table.
- **It misses the 2x instruction count in `ghia-bench`.** While upstream GPUI used less wall CPU percentage than Electron during the 6 s scroll (35.4% vs 51.7%), it executed **2.01 times as many instructions** (8,256M vs 4,109M) and used **1.76 times the `rusage` energy** (2,010 mJ vs 1,141 mJ). That matches heavier P-core CPU work per frame, not hidden GPU cost. Also, `ghia-bench`'s Electron app uses SolidJS (not React 18), and its GPUI app uses raw upstream GPUI (not GPUI Fast or GPUI Kit).
- **It cites the wrong Hacker News comment for the 5-toolkit scroll table.** Section `2.3` links `item?id=50390881` as having the table (`Iced 0.10 ms`, `Dioxus 0.28 ms`, `egui 0.55 ms`, `GPUI 3.79 ms`, `Slint 4.23 ms`). Comment `50390881` has no numbers at all ("From what I've heard..."). The table appears later in `item?id=50392548` (6 Nov 2026), where the author explicitly labels it a "vibe coded benchmark ported from the JS framework benchmark" measuring update+build time in a virtualized macOS VM.
- **It wrongly claims no other toolkit has published numbers against Electron.** Section `2.3` states: "For every other toolkit: no published number against Electron." In fact, `ghia-bench`'s published report compares Electron side-by-side against four other packaged apps (Ghia, raw GPUI, SwiftUI, MyGo), and implements nine builds in the repository.

**Evidence:**
- `ghia-bench` rusage and GPU collectors: [Sample.swift](https://github.com/fdarian/ghia-bench/blob/main/harness/helper/Sources/benchhelper/Sample.swift), [Gpu.swift](https://github.com/fdarian/ghia-bench/blob/main/harness/helper/Sources/benchhelper/Gpu.swift) (read 21 Nov 2026).
- `ghia-bench` full published table: [published/2026-11-05-no-capture/report.md](https://github.com/fdarian/ghia-bench/blob/main/published/2026-11-05-no-capture/report.md) (read 21 Nov 2026).
- Hacker News comments: [item 50390881](https://news.ycombinator.com/item?id=50390881), [item 50392548](https://news.ycombinator.com/item?id=50392548) (read 21 Nov 2026).

**What to write instead:**
Fix the HN link to `50392548`, note that `ghia-bench` reports `rusage` CPU/SoC energy (not GPU) alongside a 2.01x instruction count for upstream GPUI versus SolidJS Electron, and explain that **neither** benchmark measures GPUI Fast + GPUI Kit with AccessKit enabled on Linux Wayland.

---

### 2.3 The claim that Studio must keep shipping a Chromium

**Sections:** `The short answer`, `1.5`, `2.5`, `3.1`, `3.2`

**Why it is wrong or weak:**

- **The CDP count is undercounted and misses the `cdp-policy.ts` allowlist.** The plan cites 107 CDP methods across 14 domains in `src/main/browser/` and `src/main/preview-input.ts`. It misses `src/main/browser/cdp-policy.ts`, which allowlists **141 CDP methods** for `codara_browser_use` (`tab.cdp.send`), including the `Accessibility` and `Overlay` domains (not listed in the plan's 14 domains).
- **It misses non-CDP Chromium dependencies already in the codebase.** Studio currently uses Chromium for much more than embedded CDP browser tabs:
  - `src/main/browser/record/video-encoder.ts` and `src/preload/record-encoder.ts` spin up a hidden Electron `WebContentsView` to encode MP4 (H.264) and WebM (VP9/VP8) screen recordings through **WebCodecs `VideoEncoder`**.
  - `src/main/browser/capture/codec.ts` runs `OffscreenCanvas.convertToBlob` inside the main Electron window via `webContents.executeJavaScript` to encode WebP screenshots.
  - `src/preload/inspector-preload.ts` and `src/preload/guest/` rely on Electron `<webview>` isolated-world preloads and synchronous `ipcRenderer` to intercept `alert`/`confirm`/`prompt` (`preview-dialogs.ts`), pick elements, and forward unhandled chord shortcuts (`guest-chords.ts`).
  - `src/main/browser/fresh-tabs.ts` uses Electron in-memory `session` partitions for logged-out tabs.
  - `src/renderer/src/components/Preview/agent-presence/` renders a gliding cursor and clickable Stop banner **above** the `<webview>` with click-through (`pointer-events: none` except the Stop button) that never appears in agent screenshots or recordings (`DESIGN.md`).
- **It conflates "agents need Chromium CDP" with "Studio must bundle CEF inside its installer."** System webviews (`WKWebView` on macOS, `WebKitGTK` on Linux) indeed lack native CDP (only Windows `WebView2` exposes native CDP via `CallDevToolsProtocolMethodAsync`). However, bundling CEF is **not** the only Chromium option, and it brings a serious trap the plan misses: Spotify's prebuilt CEF binaries downloaded by `cef-rs` omit proprietary codecs (H.264/AAC) by default, which breaks Studio's MP4 WebCodecs video recording unless Studio compiles CEF from source (`proprietary_codecs=true`) or moves video/WebP encoding to native Rust/OS encoders.
- **It dismisses managing a real external Chrome/Chromium too quickly.** Launching the user's installed Chrome, Chromium, Brave or Edge (or an on-demand Chrome for Testing binary) with a Studio-owned profile and `--remote-debugging-pipe`, alongside the already-shipped Chrome and Firefox extensions (`extensions/chrome/`, `extensions/firefox/`), gives full 141-method CDP, native DevTools, working H.264, zero CEF C++ build cost, and a tiny Studio binary. The only real product loss is tabs living inside the same split pane versus a companion browser window, which should be an explicit owner trade-off rather than a hidden assumption.

**Evidence:**
- `src/main/browser/cdp-policy.ts` (141 allowlisted methods across 11 domains including `Accessibility` and `Overlay`).
- `src/main/browser/record/video-encoder.ts`, `src/preload/record-encoder.ts`, `src/main/browser/capture/codec.ts`, `src/preload/inspector-preload.ts`, `src/main/browser/preview-dialogs.ts`, `src/main/browser/guest-chords.ts`, `src/main/browser/fresh-tabs.ts`.
- `DESIGN.md` (lines 42 to 82, "The agent's hand on a browser tab").
- `cef-rs` packaging and binary download: [tauri-apps/cef-rs README](https://github.com/tauri-apps/cef-rs/blob/dev/README.md) (read 21 Nov 2026).
- WebView2 native CDP vs WebKit Inspector: [WebView2 docs via search](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2) (verified 21 Nov 2026).

**What to write instead:**
Separate the two questions: (1) replacing hidden Chromium helpers (move WebP encoding to Rust `image`/`webp` and video recording to native OS encoders or an explicit codec strategy), and (2) choosing between embedded CEF (with codec, overlay, and installer-size costs) versus an external managed Chromium / Chrome extension backend.

---

### 2.4 Licence statements

**Sections:** `2.1`, `2.2`, `2.5`, `3.3`

**Why it is wrong or weak:**

- **The GPL warning on Zed's `zlog` and `ztracing` is stale.** Section `3.3` cites secondhand reports that `zlog` and `ztracing` are GPL. Direct inspection of Zed's `main` branch on 21 Nov 2026 shows `crates/zlog/Cargo.toml`, `crates/ztracing/Cargo.toml` and `crates/ztracing_macro/Cargo.toml` are all `Apache-2.0`. Keeping `cargo deny` in CI is still right because Zed's repo mixes GPL and Apache crates, but the table row is out of date.
- **CEF, Chromium and Qt WebEngine licences were left unverified, missing key compliance rules.**
  - CEF itself is verified **BSD-3-Clause** (`chromiumembedded/cef/master/LICENSE.txt`). However, Chromium bundles LGPLv2.1 libraries (such as FFmpeg), and enabling H.264/AAC for video playback or recording adds patent-pool licensing issues beyond copyright notices.
  - Qt WebEngine's Qt code is dual-licensed Commercial / LGPLv3 / GPLv3 / GPLv2, and its bundled Chromium includes **LGPLv2.1** components (`doc.qt.io/qt-6/qtwebengine-licensing.html`). That requires dynamic linking and relinkability on every platform, plus shipping Chromium's full license notice bundle. (Also note Qt WebEngine 6.140.0 tracks Chromium 140, trailing CEF 156 and Electron 45 by 16 milestones.)
- **Apache-2.0 NOTICE obligations are glossed over.** Section `3.3` says MIT Studio can take in Apache-2.0 code "Fine", without noting that Apache-2.0 requires propagating upstream `NOTICE` files (GPUI, GPUI Fast, GPUI Kit, `alacritty_terminal`, `rmcp`, `russh`) in every binary distribution. That needs automated generation (for example `cargo-about`), not manual edits to `THIRD_PARTY_NOTICES`.
- **`libghostty-vt` is cited secondhand with no licence and stale crate details.** Primary source confirms Ghostty and `libghostty-vt` 1.0 (released 6 Nov 2026) are **MIT** with a stable C ABI. The third-party `libghostty-vt` crate on crates.io (`0.2.2`, published 28 Sep 2026, `MIT OR Apache-2.0`) predates the 1.0 C ABI release.

**Evidence:**
- Zed crate licences: [crates/zlog/Cargo.toml](https://github.com/zed-industries/zed/blob/main/crates/zlog/Cargo.toml), [crates/ztracing/Cargo.toml](https://github.com/zed-industries/zed/blob/main/crates/ztracing/Cargo.toml), [crates/ztracing_macro/Cargo.toml](https://github.com/zed-industries/zed/blob/main/crates/ztracing_macro/Cargo.toml) (read 21 Nov 2026).
- CEF licence: [chromiumembedded/cef LICENSE.txt](https://github.com/chromiumembedded/cef/blob/master/LICENSE.txt) (read 21 Nov 2026).
- Qt WebEngine licence and Chromium base: [doc.qt.io/qt-6/qtwebengine-licensing.html](https://doc.qt.io/qt-6/qtwebengine-licensing.html) (read 21 Nov 2026).
- `libghostty-vt` 1.0 announcement and licence: [mitchellh.com/writing/libghostty-1-0](https://mitchellh.com/writing/libghostty-1-0) (6 Nov 2026, read 21 Nov 2026), [ghostty-org/ghostty API](https://api.github.com/repos/ghostty-org/ghostty) (read 21 Nov 2026), [crates.io libghostty-vt](https://crates.io/api/v1/crates/libghostty-vt) (read 21 Nov 2026).
- Crate versions/licences checked via crates.io API on 21 Nov 2026 (`velopack` 1.3.39 MIT, `notify` 9.0.0-rc.9 CC0-1.0, `tauri` 3.0.0-alpha.6 Apache-2.0 OR MIT).

**What to write instead:**
Replace every "not re-verified" licence cell with the verified licences above, update `zlog`/`ztracing` to Apache-2.0 while keeping `cargo deny` for Zed's mixed monorepo, add automated Apache-2.0 `NOTICE` generation, and flag CEF's H.264/codec patent boundary explicitly.

---

### 2.5 The "Rust core first, native shell second" strategy against the alternatives

**Sections:** `4`, `5`

**Why it is wrong or weak:**

- **Building an in-process Node native addon first, then ripping it out for a daemon in Wave 5, does the hardest boundary work twice.** Phase 1 builds a `.node` addon loaded inside Electron's main process and ports Waves 1 to 4 behind per-module FFI switches. Wave 5 then moves the core into a separate host process, and Phase 7 deletes the addon. You pay for N-API marshaling, Electron ABI rebuilds, and `.node` notarization across 190,000 lines of main code, only to throw that boundary away and build an IPC protocol anyway. Worse, an in-process addon does not survive Electron or GPU crashes until Wave 5.
- **The claim that all 579 unit suites run unchanged during Phase 2 contradicts section `1.4`.** Section `4` sells Option B and E on: "Continuous. Unit suites and e2e specs run unchanged on every step." Yet our repo check confirms **466 of 579** `scripts/test-*` files bundle `src/` TypeScript modules directly with `esbuild` in-process (394 name `src/` paths) and inject JS fakes (fake clocks, fake `WebContents`, fake `ssh2` channels, fake `pty-manager`, fake `BrowserWindow`). Only 43 mention `agent-socket`. Once Phase 2 deletes the TypeScript implementation of a module, those `esbuild` suites break unless you expose hundreds of internal mock seams across FFI. Only the 169 Playwright specs and black-box contract tests actually stay unchanged.
- **It misses the renderer-to-main ownership inversion.** Today, the React renderer owns workspace tab trees, split layouts, terminal inventories, workspace saving (`state:save`), and browser DOM actions. Main has to call *back* into the renderer over three reverse IPC bridges: `src/main/terminal-bridge.ts` (14 ops), `src/main/preview-bridge.ts` (18 ops), and `src/main/desktop-command-bridge.ts`. Porting `src/main/` to Rust without first moving state ownership out of React leaves the Rust core unable to drive tabs, terminals, or browser actions on its own.
- **The option matrix omits the cleanest strategy: an out-of-process Rust daemon from Wave 1.** Comparing only an in-process addon (B/E) against Big Bang (A) and GPUI-first over Node main (D) misses starting with a standalone `codara-core` process over a Unix socket / Windows named pipe that both Electron and any future shell talk to as thin clients.

**Evidence:**
- `scripts/test-terminal-agent-notify.cjs`, `scripts/test-agent-worktrees.cjs`, `scripts/test-remote-access.cjs` (all bundle `src/main/*.ts` via `esbuild` and inject JS fakes).
- `src/main/terminal-bridge.ts` (lines 1 to 58), `src/main/preview-bridge.ts` (lines 1 to 60), `src/main/desktop-command-bridge.ts`, `src/renderer/src/components/Preview/previewRpc.ts`, `docs/architecture.md` (line 693).

**What to write instead:**
Keep "Rust core first, native shell second", but make the core an **out-of-process daemon (`codara-core`) from Wave 1**, invert tab/workspace/browser ownership out of React first, and state honestly that internal `esbuild` unit suites get ported to Rust unit tests while the 169 Playwright e2e specs and socket/protocol suites provide continuous black-box parity.

---

### 2.6 Order of the phases

**Section:** `5`

**Why it is wrong or weak:**

- **Wave 5 (the out-of-process core host) is placed last in Phase 2 instead of first.** Putting the process boundary at the start gives surviving terminals immediately, avoids throwaway N-API bindings, and gives the UI, CLI and MCP server one stable protocol from the start.
- **Phase 3 starts too early ("when wave 1 is done, beside waves 2 to 4").** Phase 3 builds the workspace rail, tabs, splits, shortcuts, command palette and notification center, which all need core-owned workspace/tab state, `storage`, `preferences`, `notify` and `agent-socket` (not ported until Waves 2 and 4). Starting Phase 3 after Wave 1 forces the GPUI shell to target half-migrated Node/Rust APIs or stall.
- **Phase 4 depends on Phase 5 but runs before/beside it.** Phase 4 relies on Phase 5's Chromium helper to render PDF/Office previews, Mermaid diagrams, node-graph editors and vim mode. Phase 4 slices for chat, editor, automations and whiteboard cannot pass parity proofs until Phase 5's helper contract exists.
- **Phase 1 assumes release automation for Linux and Windows native builds already exists.** Phase 1 item 5 asks for "the addon built, signed and notarized inside today's nightly for macOS, Windows and Linux". Today's `.github/workflows/release.yml` runs on `macos-latest` only: it cross-builds Windows on macOS (`npm run package:win`) and builds **no Linux release at all** (`README.md`: "On Linux, build it yourself"). Native Rust (and later CEF) builds require adding real `windows-latest` and `ubuntu-latest` build jobs and updating `scripts/release-bundle.cjs` before Phase 1 can pass its own proof.
- **Cora's engine and Pi stay tangled with Electron main until Wave 5.** Leaving `src/main/orchestration/` (78,383 lines) inside Electron main through Waves 1 to 4 keeps main coupled to `BrowserWindow`, `app`, and `resolveCodaraPiLibrary` for almost the entire backend migration. Splitting Cora/Pi into a managed Node sidecar earlier decouples orchestration from the UI shell cleanly.

**Evidence:**
- `.github/workflows/release.yml` (lines 102 to 152: single `macos-latest` build job for macOS and Windows; zero Linux build or feed).
- `README.md` (lines 12 to 16).
- Plan section `5` (Phase 1 item 5, Phase 2 Wave 5, Phase 3, Phase 4, Phase 5).

**What to write instead:**
Order the work as: (0) upgraded spikes + heap profile; (1) CI/release runners for all three OSes + Cargo workspace + move tab/workspace/browser ownership out of React; (2) `codara-core` daemon from Wave 1 (PTYs, VT/notifier, sockets, storage), then doors/security/rest of main, plus splitting Cora/Pi into its own Node worker; (gate) re-measure and decide whether to stop; (3) browser backend decision (managed Chromium vs CEF helper) + UI test driver + GPUI skeleton; (4) remaining UI slices; (5) bridge release and switchover; (6) remove Electron.

---

### 2.7 Proofs of done and spikes

**Sections:** `5`, `8`

**Why it is wrong or weak:**

- **Spike S1 misses the three conditions that actually break GPUI Fast.** S1 never tests with **AccessKit enabled** (which disables virtual-list scroll layers in `gpui-fast`), never specifies testing **GPUI Kit components** (whose render-time global writes defeat retained mode), and tests scrolling and terminal streaming **separately** rather than simultaneously with active spinners/cursors (which trigger layer bypass). It also ignores Wayland compositor CPU (`cosmic-comp`) and GPU power draw.
- **Spike S2 misses Studio's hardest browser invariants.** S2 only checks "menus drawn above the page" and 107 CDP methods. It misses:
  - interactive click-through overlays (`agent-presence` gliding cursor + clickable Stop button that must not appear in screenshots);
  - all 141 allowlisted CDP methods in `cdp-policy.ts`;
  - background tab painting (`preview-target.ts` `keepPainting` and `captureViewport`);
  - logged-out in-memory partitions (`fresh-tabs.ts`);
  - guest chord forwarding (`guest-chords.ts`) and synchronous page dialogs (`preview-dialogs.ts`);
  - H.264/VP9 WebCodecs recording (`video-encoder.ts`) and WebP encoding (`capture/codec.ts`);
  - GPU-crash fallback on Linux Wayland + NVIDIA.
- **Spike S4 misidentifies the phone transport cryptography.** Section `2.5` says "`snow` 0.10.0 for Noise, plus the stream framing by hand". Primary inspection of `holepunchto/hyperswarm-secret-stream` proves it does **not** use standard Noise transport ciphers: it runs `noise-handshake` with `noise-curve-ed` (Ed25519 keys converted to X25519), 3-byte little-endian length framing, BLAKE2b namespace derivation (`hyperswarm/secret-stream`), and **`sodium-secretstream` (`crypto_secretstream_xchacha20poly1305`)** for encrypted frames (plus a separate `secretbox` send state). S4 must test against `crypto_secretstream_xchacha20poly1305` and `noise-curve-ed` semantics, not standard `snow` transport.
- **Spike S5 cannot run on Linux as written and misses Windows NSIS and macOS Keychain traps.** S5 says "take the current public Electron build ... on macOS, Windows and Linux", but no public Linux update feed exists today (`release.yml` only publishes `latest.yml` and `latest-mac.yml`). On Windows, `build/installer.nsh` runs `ELECTRON_RUN_AS_NODE=1` on uninstall (`customUnInstall`), so switching installer frameworks risks running the old uninstaller's cleanup hook or breaking Start Menu `AppUserModelID` (`com.codara.app`). On macOS, a new Rust binary reading Keychain items migrated by the Electron bridge release can trigger OS Keychain ACL prompts unless signing identity and Keychain access match. Also, the bridge release must migrate **all three** `safeStorage` stores (including `src/main/feedback/admin-token.ts`, which the plan missed).
- **Phase 1 proof ("bundle budgets unchanged") conflicts with its own deliverables.** Moving 53 `localStorage` keys out of the renderer changes `out/renderer` and `out/preload`, where `scripts/bundle-budgets.json` enforces ~1% headroom.
- **Phase 3/4 proof overestimates how cleanly Playwright specs port.** Section `1.4` counts 962 `locator(` calls and 339 `evaluate(` calls in `tests/e2e/` versus 758 `getByRole(` and 219 `getByTestId(`. An AccessKit debug socket cannot answer CSS `locator(` queries or JS `evaluate(` calls; over half of the 169 e2e assertions will need behavior-level rewrites, not a thin client adapter.

**Evidence:**
- `gpui-fast` scroll-layer caveats: [docs/scroll-layers.md](https://github.com/longbridge/gpui-fast/blob/main/docs/scroll-layers.md) (read 21 Nov 2026).
- `@hyperswarm/secret-stream` wire protocol: [index.js](https://github.com/holepunchto/hyperswarm-secret-stream/blob/main/index.js), [lib/handshake.js](https://github.com/holepunchto/hyperswarm-secret-stream/blob/main/lib/handshake.js) (read 21 Nov 2026).
- `build/installer.nsh`, `src/main/index.ts` (line 245), `src/main/feedback/admin-token.ts`, `scripts/bundle-budgets.json`, `.github/workflows/release.yml`.

**What to write instead:**
Tighten S1 through S5 with the exact failure modes above, require S4 to prove `noise-curve-ed` + `crypto_secretstream_xchacha20poly1305` wire parity, drop the impossible Linux public-feed test from S5 until a Linux feed exists, and explicitly plan a new semantic test harness for the CSS/JS-dependent half of the e2e suite.

---

## 3. What the plan missed

### 3.1 Subsystems absent from sections `1.4` and `2.5` (over 18,000 lines in `src/main/`)

- **Workspace task list and verify gate (`src/main/cos/`, 1,894 lines):** manages `<codaraHome>/cos/<workspace>/tasks.jsonl`, rendered `TASKS.md`, `verify/` logs, `workspace-origins.json`, and `codara_task_*` tools (`src/main/preview-tools/cos-tasks.ts`).
- **Active Claude account in other terminals (`src/main/claude-follow/`, 2,560 lines):** manages shell rc blocks, two-way `~/.claude.json` MCP/trust sync, Windows hard-link sync, and the `uninstall-entry.ts` hook called by `build/installer.nsh`.
- **Dev server keeper and launch args (`src/main/servers/`, 2,136 lines):** runs and tracks project dev servers plus per-runtime launch arguments (`src/main/preview-tools/servers.ts`).
- **Agent CLI update manager (`src/main/agent-cli-updates/`, 1,985 lines):** checks and runs CLI updates with a quit/launch guard (`launch-guard.ts`) wired into `src/main/index.ts`.
- **Share as link (`src/main/share/`, 1,223 lines; `src/renderer/src/components/share/`, `docs/share-links.md`):** builds self-contained sandboxed HTML via `parse5` (which section `1.4` misattributed to the in-app browser), fetches CDN assets with SRI checks, and signs uploads with an Ed25519 key in `share/identity.json`.
- **Keep awake (`src/main/keep-awake/`, 1,157 lines):** combines OS keep-awake holds with a Linux `systemd-inhibit --what=sleep:handle-lid-switch --mode=block cat` child process.
- **Session relay with approval (`src/main/session-relay/`, 949 lines):** implements `codara_session_relay` with trusted-window `relay:decide` approval and phone-answer bypass rules.
- **Feedback service (`src/main/feedback/`, 819 lines):** stores the anonymous install UUID (`feedback.json`) and a `safeStorage`-encrypted staff admin token (`admin-token.ts`).
- **Review diff and review notes (`src/main/review/`, 1,146 lines):** workspace diffing and persisted review notes under `workspace-data/<workspace>/review/`.
- **Workspace status (`src/main/workspace-status/`, 671 lines):** persisted status/checkpoints (`workspace-status.json`) and in-memory agent notes (`codara_workspace_status`).
- **Agent hibernation (`src/main/agent-hibernation.ts`, `agent-hibernation-census.ts`):** only mentioned in passing in `6.5`, not mapped in `1.4` or `2.5`.
- **Inline AI (`src/main/inline-ai.ts`):** editor fill-in-the-middle completion over OpenRouter.
- **System metrics (`src/main/system-metrics*.ts`):** live CPU, RAM, GPU and process telemetry.
- **Outside-write guard (`src/main/outside-write-guard.ts`):** hard security guard blocking writes (including symlink escapes) into `~/.claude`, `~/.codex`, `~/.grok` and custom CLI homes, enforced by `scripts/test-outside-write-guard.cjs`.
- **AppImage boot/crash shims (`src/main/appimage-launch.ts`, `appimage-launch-boot.ts`, `src/main/diagnostics/appimage-crashpad.ts`).**
- **Planned read-only bot connector (`docs/bot-connector.md`):** adds a `role: "bot"` Noise IK peer, secret redaction pipeline, and five `bot.*` RPCs on the remote-access relay.

### 3.2 Contracts and hidden dependencies absent from section `1.5`

- **Desktop command Unix socket (`src/main/desktop-command-socket.ts`):** `~/.codarastudio/desktop-command.sock` (mode `0600`) accepting `new-terminal\n` and `open-path /abs/path\n` so Linux Wayland global shortcut scripts can drive Studio.
- **Hook RPC loopback HTTP server (`src/main/hook-rpc.ts`):** `127.0.0.1` server on an ephemeral port (`SPARK_HOOK_URL`, `SPARK_HOOK_TOKEN`, `POST /state`, `GET /healthz`).
- **Browser code mode (`src/main/browser/code/`, `docs/browser-code-mode.md`):** `codara_browser_use` runs up to 16 persistent QuickJS-WASM worker threads (64 MB heap each), transforms snippets with `acorn` (top-level `await` + REPL redeclaration semantics), and enforces the 141-method `cdp-policy.ts` allowlist. Replacing `acorn` in Rust requires a real JS parser/rewriter (`oxc_parser` or `swc_ecma_parser`), not just `rquickjs`.
- **Hidden Chromium media encoders:** WebCodecs H.264/VP9 video encoding (`src/main/browser/record/video-encoder.ts`), `OffscreenCanvas` WebP encoding (`src/main/browser/capture/codec.ts`), and `html-to-image` whiteboard PNG export (`src/renderer/src/components/whiteboard/inspect-whiteboard.tsx`).
- **`ELECTRON_RUN_AS_NODE=1` as a persisted detection contract:** `src/main/mcp-installer.ts` (lines 550, 717, 912) and `src/main/global-config-cleanup.ts` (line 241) inspect `ELECTRON_RUN_AS_NODE === "1"` in `~/.claude.json` and `~/.codex/config.toml` to recognize Codara-owned entries, and `build/installer.nsh` invokes it during Windows uninstall.
- **Third `safeStorage` caller and plaintext fallback:** `src/main/feedback/admin-token.ts`, plus `CODARA_DISABLE_KEYCHAIN=1` and no-keyring fallback behavior in `src/main/storage.ts`.
- **Postinstall OAuth branding patch (`scripts/brand-pi-oauth-page.cjs`):** patches `@earendil-works/pi-ai/dist/utils/oauth-page.js` on disk so OAuth sign-in tabs show Codara Studio instead of Pi; any standalone Node/Pi bundle must carry this patch.
- **Pi `proper-lockfile` credential locking (`src/main/orchestration/pi-auth-storage.ts`):** writes to `auth.json` must obey Pi's exact `proper-lockfile` lock protocol or race with running Pi sessions rotating OAuth tokens.
- **Three main-to-renderer reverse IPC bridges:** `src/main/terminal-bridge.ts`, `src/main/preview-bridge.ts`, and `src/main/desktop-command-bridge.ts`.
- **Cross-repo contract checks (`scripts/test-remote-access.cjs`):** verifies QR payloads and RPC types directly against sibling checkout `../codara-mobile` when present.
- **macOS Hardened Runtime entitlements (`build/entitlements.mac.plist`) and Windows `AppUserModelID` (`src/main/index.ts`, line 245).**
- **124 platform-branched files in `src/main/` (`process.platform`) and 9 `worker_threads` workloads** (`fs-watcher`, `usage-scan`, `usage-analytics`, `session-index`, `workflow-sandbox`, `browser/code/kernel`, `browser/perf`, `browser/record/gif-worker`, `diagnostics/hang-watchdog`).

### 3.3 Missed options

- **Out-of-process `codara-core` daemon from Wave 1** instead of a throwaway N-API `.node` addon.
- **External managed Chromium / Chrome for Testing via `--remote-debugging-pipe`** alongside the existing Chrome and Firefox extensions, avoiding CEF bundling, H.264 rebuilds, and Wayland surface embedding completely when a companion browser window is acceptable.
- **Direct C bindings (`bindgen`) to `libghostty-vt` 1.0** (MIT, stable C ABI since 6 Nov 2026) instead of relying on the pre-1.0 third-party `libghostty-vt` 0.2.2 crate.

---

## 4. Recommendation

### Strategy: Out-of-process `codara-core` daemon first, UI shell second (with a hard stop gate)

Do **not** build an in-process Node native addon. Instead, build a standalone Rust daemon (`codara-core`) speaking a versioned local IPC protocol (Unix domain socket on macOS/Linux, named pipe on Windows).

1. **Invert state ownership first.** Move workspace state, tab/pane trees, and browser tab registries out of React (`localStorage` and `useTabs`) into the backend while still on Electron, eliminating the reverse state ownership in `terminal-bridge.ts` and `preview-bridge.ts`.
2. **Move backend subsystems into `codara-core` in waves**, starting with PTYs, VT/agent detection, scrollback, `agent-socket`, `hook-rpc`, and `desktop-command.sock`. Keep Cora's Pi engine as a managed Node child process (with patched `pi-ai`) until a heap profile proves porting its 78,383 lines is worth it.
3. **Stop and measure after `codara-core` is complete.** At that point terminals already survive UI crashes and updates, all heavy main-process work is off V8, and Electron is a thin shell. On a working day where 3 agent sessions use 1.5 GB of RAM on their own, this gate may already deliver the stability and responsiveness the owner wants.

### Toolkit (only if crossing the gate into a UI rewrite)

- **Native Rust UI pick:** **GPUI via `gpui-fast` + `gpui-kit` (pinned and vendored)**, *only if* an upgraded Spike S1 passes with AccessKit enabled, GPUI Kit components mounted, simultaneous streaming + scrolling, and a viable Linux Wayland GPU fallback.
- **Browser strategy:** Support **external managed Chromium (over `--remote-debugging-pipe`) plus the existing Chrome/Firefox extensions** as the clean, low-risk default; add **embedded CEF** (tested via `gpui-fast` window composition vs CEF OSR) only if Spike S2 passes `agent-presence` click-through overlays, 141-method CDP, isolated sessions, and Wayland+NVIDIA stability, and move WebP/video encoding out of Chromium into native Rust/OS encoders.
- **Fallback shell:** If S1 or S2 fails, **keep the React UI on `codara-core`** (stay on Electron until **Tauri 3 + CEF** fixes its Linux idle-CPU, focus, and packaging bugs, then swap the shell with almost no UI rewrite). Do not rebuild 203k lines of IDE UI in Slint, egui, Iced, or Qt.

### First three steps

1. **Run upgraded spikes S1 to S5 and capture the main-process heap snapshot.** Upgrade S1 (GPUI Kit + `gpui-fast` with AccessKit on, simultaneous streaming and scrolling, Wayland+NVIDIA and compositor CPU), S2 (`gpui-fast` composition vs CEF OSR vs managed external Chromium with `agent-presence` click-through overlay, all 141 CDP methods, isolated partitions, dialogs, chords, and WebCodecs/H.264), S3 (`alacritty_terminal` vs direct `libghostty-vt` 1.0 C ABI bindings on recorded notifier fixtures), S4 (`noise-curve-ed` + `crypto_secretstream_xchacha20poly1305` wire interop against unchanged remote-access suites), and S5 (macOS/Windows in-place upgrade including NSIS `customUnInstall`, all 3 `safeStorage` stores, Keychain ACLs, and standalone Node + patched Pi).
2. **Stand up multi-OS Rust CI/release and invert state ownership in TypeScript.** Add `windows-latest` and `ubuntu-latest` Rust build jobs to CI and `release.yml`, initialize the `crates/` workspace with `cargo deny` and automated `NOTICE` generation (`cargo-about`), and move tab/pane/workspace state out of React `localStorage` into one backend-owned store.
3. **Ship `codara-core` daemon v1 under today's Electron UI.** Move PTYs, headless VT + agent-state detection, scrollback persistence, `agent-socket`, `hook-rpc`, and `desktop-command.sock` into the out-of-process Rust daemon, prove parity with the 169 Playwright e2e specs plus new Rust unit suites, and re-measure startup, memory, and many-agent stall latency before starting Phase 3.

---

## 5. Suggested changes

1. Replace the Phase 1 to Wave 5 Node native addon with an out-of-process `codara-core` daemon from Wave 1. This removes a throwaway N-API boundary and delivers crash-surviving terminals at the first milestone instead of the last.
2. Add an explicit prerequisite step in Phase 1 to move workspace, tab, pane, and browser-tab ownership out of React (`useTabs`, `localStorage`, `terminal-bridge.ts`, `preview-bridge.ts`) into the backend. Without inverting that ownership first, a Rust core cannot drive tabs, terminals, or browser tools independently of Electron's renderer.
3. Upgrade Spike S1 to test GPUI Kit components with AccessKit enabled, simultaneous terminal streaming and scrolling, active spinners/cursors, and Wayland compositor CPU on NVIDIA. `gpui-fast`'s own docs state that AccessKit disables virtual-list scroll layers and GPUI Kit's render state forces ancestor rebuilds, so the current S1 would give a false pass.
4. Update sections `2.1`, `3.1` and Spike S2 to account for `gpui-fast`'s existing Wayland/X11/macOS/Windows native window composition and test `agent-presence` click-through overlays, all 141 allowlisted CDP methods, isolated partitions, dialogs, chords, and WebCodecs H.264 recording. The plan currently treats Wayland composition as absent and tests only menu z-order and 107 CDP methods, missing the real blockers.
5. Add an external managed Chromium (via `--remote-debugging-pipe`, paired with the existing Chrome and Firefox extensions) as a first-class option beside embedded CEF, and decouple WebP/video encoding from Chromium. Stock CEF binaries omit H.264 proprietary codecs and add hundreds of megabytes plus Wayland embedding risk that a companion Chromium or native encoders avoid.
6. Correct section `2.3` by fixing the Hacker News table citation to `item?id=50392548`, clarifying that `ghia-bench`'s `Energy (mJ)` is `proc_pid_rusage` CPU/SoC energy (not GPU) paired with a 2.01x instruction count, and noting `ghia-bench` tests five packaged apps against Electron. Keeping the misread energy explanation and wrong link weakens the credibility of the benchmark verdict.
7. Update section `3.3` with primary-source licences: Zed's `zlog`/`ztracing` are now `Apache-2.0`, CEF is `BSD-3-Clause` (with Chromium LGPLv2.1 and codec-patent caveats), Qt WebEngine is Commercial/LGPLv3/GPL with LGPLv2.1 Chromium parts, `libghostty-vt` 1.0 is `MIT`, and Apache-2.0 requires automated `NOTICE` bundling. Accurate primary-source licence rules avoid both false alarms and missed distribution obligations.
8. Add `windows-latest` and `ubuntu-latest` build jobs and Linux release/update decisions to Phase 1, and drop the non-existent Linux public-feed upgrade check from Spike S5 until a Linux feed exists. Today's `release.yml` only runs on `macos-latest` and does not build Linux at all, so Phase 1 and S5 cannot pass as written.
9. Rewrite Spike S4 to target `@hyperswarm/secret-stream`'s actual wire stack (`noise-curve-ed` Ed25519-to-X25519 Noise IK, 3-byte little-endian framing, BLAKE2b namespaces, and `crypto_secretstream_xchacha20poly1305`) instead of standard `snow` transport. Standard `snow` transport encryption is wire-incompatible with the phone app and relay.
10. Stop claiming all 579 `scripts/test-*` suites will run unchanged across Phase 2, and separate the plan's proofs into black-box contract/e2e suites (kept unchanged) versus the 466 `esbuild` in-process suites (ported to Rust unit tests as modules move). Pretending `esbuild` mock-injected JS suites will keep working after deleting TypeScript modules hides real test-porting work.
11. Do not start Phase 3 until Wave 1 plus core state/storage/notifications/sockets are stable, and place Phase 5's browser/web-preview helper before Phase 4's web-dependent slices. The current overlap makes Phase 3 and Phase 4 depend on interfaces that do not exist yet.
12. Add the missing subsystems and contracts from section 3 of this review (`cos/`, `claude-follow/`, `servers/`, `agent-cli-updates/`, `share/`, `keep-awake/`, `session-relay/`, `feedback/` including its third `safeStorage` store, `review/`, `workspace-status/`, `outside-write-guard.ts`, `desktop-command.sock`, `hook-rpc.ts`, `browser/code/` `acorn` transforms, `ELECTRON_RUN_AS_NODE` cleanup detection, `build/installer.nsh`, `brand-pi-oauth-page.cjs`, and Pi `proper-lockfile` locking) to the subsystem map and migration checklist. Missing any of these will break existing user installs, uninstalls, Wayland shortcuts, or security boundaries during switchover.
13. Evaluate direct C bindings (`bindgen`) to `libghostty-vt` 1.0 in Spike S3 instead of the pre-1.0 `libghostty-vt` 0.2.2 crate. The 0.2.2 crate was published on 28 Sep 2026 before the stable 1.0 C ABI shipped on 6 Nov 2026.
14. Add an explicit Linux Wayland GPU-crash recovery requirement to Phase 3 and Spike S1 (mirroring `src/shared/gpu-drawing.ts`). Studio already had to disable hardware acceleration by default on native Wayland because driver crashes killed the app, and a single-process GPUI window needs a tested fallback path.

---

## 6. What I could not verify

1. **Live hardware measurements on this machine:** Per the review brief, no builds or spikes were run, so GPUI Fast frame times at 360 Hz on NVIDIA + COSMIC Wayland, Wayland dead-key/compose-key IME in GPUI Kit, and the heap breakdown of Studio's 475 MB main process remain unmeasured.
2. **CEF combined with `gpui-fast` window composition on Linux Wayland:** `gpui-fast` documents `wl_subsurface` composition and runs a GPU-surface example on Linux, but whether CEF (native subsurface or OSR texture) composes cleanly with `agent-presence` click-through overlays under NVIDIA + Wayland is untested.
3. **Screen reader quality in GPUI / GPUI Kit:** AccessKit dependencies and test claims are verified in manifests and READMEs, but real VoiceOver, NVDA/Narrator, and Orca behavior was not tested.
4. **Private sibling repositories:** The phone app (`codara-mobile`), the remote-access relay, the share service (`codara-share`), and the planned bot bridge live outside this public repository, so their wire tolerances and release constraints could not be inspected directly.
5. **`ghia-bench` GPU time and frame-capture latencies:** Although `Gpu.swift` exists in the repo, the only published run (`2026-11-05-no-capture`) ran with `--capture off` and omitted GPU time and latency rows from its summary report.
6. **Direct Rust decryption of Electron `safeStorage` and macOS Keychain ACL prompts:** Whether a newly signed Rust binary reading Keychain entries written by an Electron bridge release triggers macOS Keychain password prompts can only be verified on signed macOS builds in Spike S5.
7. **OpenH264 / WebCodecs support in stock Spotify CEF binaries:** Whether `cef-rs`'s default downloaded CEF binaries can encode H.264 (`avc1`) via WebCodecs on Linux without building CEF with `proprietary_codecs=true` was not tested directly.
8. **Azure Artifact Signing onboarding and Windows SmartScreen reputation timelines:** Only secondary reporting was available without checking live Azure portal enrollment terms.
