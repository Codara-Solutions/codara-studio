// The update service on scripted tools, for the e2e suite only
// (CODARA_FAKE_AGENT_CLI_UPDATES=1 under SPARK_E2E_BACKGROUND). The real
// service, install detection and UI run; only the binaries, the registry and
// the process list are stand-ins. A spec drives it from main through
// globalThis.__codaraAgentCliFake: set versions, hold an update mid-way,
// make the next update's build fail its version check.

import type { UpdatableAgentCliToolId } from "@shared/agent-cli-updates";

import { detectInstallPlan } from "./install-plan";
import type { UpdateServiceDependencies } from "./service";

interface FakeTool {
  version: string | null;
  /** Where the binary really lives, which decides the install method. */
  realPath: string;
}

export interface AgentCliFakeControls {
  tools: Partial<Record<UpdatableAgentCliToolId, FakeTool>>;
  latest: Partial<Record<UpdatableAgentCliToolId, string>>;
  live: Partial<Record<UpdatableAgentCliToolId, number>>;
  /** Tools whose next update installs a build that fails its version check. */
  failNext: UpdatableAgentCliToolId[];
  /** While true, an update waits in "updating" until release(). */
  hold: boolean;
  release: () => void;
  /** While true, counting sessions waits until releaseCount(): main has not answered yet. */
  holdCount: boolean;
  releaseCount: () => void;
}

export function createFakeDependencies(): Pick<
  UpdateServiceDependencies,
  "inspect" | "latest" | "run" | "liveSessions" | "exists" | "pi" | "loadState" | "saveState" | "relink" | "lock"
> {
  let releaseHeld: (() => void) | null = null;
  let releaseCounting: (() => void) | null = null;
  const controls: AgentCliFakeControls = {
    tools: {
      claude: { version: "2.1.327", realPath: "/home/user/.local/share/claude/versions/2.1.327" },
      codex: { version: "0.170.0", realPath: "/home/user/.codex/packages/standalone/releases/0.170.0-x86_64-unknown-linux-musl/bin/codex" },
      grok: { version: "1.0.89", realPath: "/home/user/.grok/downloads/grok-1.0.89-linux-x86_64" },
    },
    latest: { claude: "2.1.327", codex: "0.170.0", grok: "1.0.89" },
    live: {},
    failNext: [],
    hold: false,
    release: () => {
      releaseHeld?.();
      releaseHeld = null;
    },
    holdCount: false,
    releaseCount: () => {
      controls.holdCount = false;
      releaseCounting?.();
      releaseCounting = null;
    },
  };
  (globalThis as { __codaraAgentCliFake?: AgentCliFakeControls }).__codaraAgentCliFake = controls;
  return {
    inspect: async (tool) => {
      const fake = controls.tools[tool];
      if (!fake) return null;
      const binaryPath = `/home/user/.local/bin/${tool}`;
      const plan = await detectInstallPlan({
        tool,
        platform: "linux",
        binaryPath,
        realPath: fake.realPath,
        npmOnPath: null,
        exists: async () => false,
        writable: async () => true,
      });
      return {
        tool,
        binaryPath,
        realPath: fake.realPath,
        version: fake.version,
        versionError: fake.version ? null : "Command exited with code 132.",
        plan,
      };
    },
    latest: async (tool) => {
      const version = controls.latest[tool];
      if (!version) throw new Error("no version");
      return version;
    },
    run: async (command) => {
      if (controls.hold) await new Promise<void>((resolve) => (releaseHeld = resolve));
      const tool = (["claude", "codex", "grok"] as const).find((id) => command.display.startsWith(id) || command.display.includes(` ${id} `));
      const fake = tool ? controls.tools[tool] : undefined;
      if (!tool || !fake) return "";
      // A roll back names its version: `install <v>`, `update --version <v>`, CODEX_RELEASE=<v>.
      const pinned =
        command.env?.CODEX_RELEASE ??
        (command.args[0] === "install" ? command.args[1] : undefined) ??
        (command.args.includes("--version") ? command.args[command.args.indexOf("--version") + 1] : undefined);
      // Like the real installers, each version is its own build on disk.
      const buildOf = (version: string) => fake.realPath.replace(/\d+\.\d+\.\d+(?:-[\w.]+)?/, version);
      if (pinned) {
        controls.tools[tool] = { realPath: buildOf(pinned), version: pinned };
        return `installed ${pinned}`;
      }
      const broken = controls.failNext.includes(tool);
      controls.failNext = controls.failNext.filter((id) => id !== tool);
      const next = controls.latest[tool] ?? fake.version ?? "0.0.0";
      controls.tools[tool] = { realPath: buildOf(next), version: broken ? null : next };
      return "updated";
    },
    liveSessions: async (tool) => {
      if (controls.holdCount) await new Promise<void>((resolve) => (releaseCounting = resolve));
      return controls.live[tool] ?? 0;
    },
    exists: async () => true,
    pi: async () => ({ version: "1.5.2", pinnedVersion: "1.5.2", source: "bundled" }),
    loadState: async () => ({ failed: {}, notOffered: {} }),
    saveState: async () => {},
    // Nothing on disk is touched: no relinking, no lock file.
    relink: undefined,
    lock: async () => async () => {},
  };
}
