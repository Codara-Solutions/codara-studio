import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SETUP_TOOLS,
  normalizeOnboardingProgress,
  type SetupToolId,
  type SetupSnapshot,
  type SetupInstallStatus,
} from "@shared/onboarding";
import { resolveBinary, clearResolverCache } from "./binary-resolver";
import { getEnrichedEnv, refreshEnrichedPath } from "./path-reconstruction";
import { codaraHome } from "./codara-home";
import { writeFileAtomic } from "./fs-atomic";

export async function loadOnboardingProgress() {
  try {
    return normalizeOnboardingProgress(
      JSON.parse(
        await fs.readFile(join(codaraHome(), "onboarding.json"), "utf8"),
      ),
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(error instanceof SyntaxError)
    )
      throw error;
    return normalizeOnboardingProgress(null);
  }
}

export async function saveOnboardingProgress(value: unknown) {
  const progress = normalizeOnboardingProgress(value);
  await fs.mkdir(codaraHome(), { recursive: true });
  await writeFileAtomic(
    join(codaraHome(), "onboarding.json"),
    JSON.stringify(progress),
  );
  return progress;
}

interface Command {
  executable: string;
  args: string[];
  display: string;
}
interface SetupDependencies {
  platform: NodeJS.Platform;
  resolve: (name: string) => Promise<string | null>;
  refresh: () => Promise<void>;
  run: (
    command: Command,
    timeout: number,
    onOutput?: (output: string) => void,
  ) => Promise<string>;
}

export async function runSetupCommand(
  command: Command,
  timeout: number,
  onOutput?: (output: string) => void,
): Promise<string> {
  const env = await getEnrichedEnv();
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: homedir(),
      env,
      windowsHide: true,
      // cmd.exe needs its quoted command intact; Node's argv escaping is for executables.
      windowsVerbatimArguments: process.platform === "win32" && command.executable === "cmd.exe",
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output = (
        output + chunk.toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      ).slice(-12_000);
      onOutput?.(output);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => child.kill());
        killer.on("close", (code) => {
          if (code !== 0) child.kill();
        });
      } else {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut)
        reject(
          new Error(
            "The command took too long. Check the installer, then recheck your tools.",
          ),
        );
      else if (code !== 0)
        reject(new Error(output.trim() || `Command exited with code ${code}.`));
      else resolve(output.trim());
    });
  });
}

export function createSetupService(deps: SetupDependencies) {
  let install: SetupInstallStatus | null = null;
  let checking: Promise<SetupSnapshot> | null = null;

  async function plan(id: SetupToolId): Promise<Command | null> {
    if (id === "codex") {
      const npm = await deps.resolve("npm");
      if (!npm) return null;
      return deps.platform === "win32"
        ? {
            executable: "cmd.exe",
            args: [
              "/d",
              "/s",
              "/c",
              '""' + npm + '" install -g @openai/codex"',
            ],
            display: "npm install -g @openai/codex",
          }
        : {
            executable: npm,
            args: ["install", "-g", "@openai/codex"],
            display: "npm install -g @openai/codex",
          };
    }
    if (deps.platform === "win32") {
      const winget = await deps.resolve("winget");
      if (!winget) return null;
      const packages = {
        git: "Git.Git",
        python: "Python.Python.3.13",
        node: "OpenJS.NodeJS.LTS",
        claude: "Anthropic.ClaudeCode",
      };
      const args = [
        "install",
        "--id",
        packages[id],
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--silent",
        "--disable-interactivity",
      ];
      return { executable: winget, args, display: `winget ${args.join(" ")}` };
    }
    if (deps.platform === "darwin") {
      const brew = await deps.resolve("brew");
      if (!brew) return null;
      const args =
        id === "claude"
          ? ["install", "--cask", "claude-code"]
          : ["install", id];
      return { executable: brew, args, display: `brew ${args.join(" ")}` };
    }
    return null;
  }

  async function probe(id: SetupToolId): Promise<string | null> {
    // Match the interpreter used by hook-installer, including Windows Store stubs.
    const name =
      id === "python" ? (deps.platform === "win32" ? "python" : "python3") : id;
    const executable = await deps.resolve(name);
    if (!executable) return null;
    const command =
      deps.platform === "win32" && /\.(cmd|bat)$/i.test(executable)
        ? {
            executable: "cmd.exe",
            args: ["/d", "/s", "/c", '""' + executable + '" --version"'],
            display: `${name} --version`,
          }
        : { executable, args: ["--version"], display: `${name} --version` };
    try {
      const output = await deps.run(command, 8_000);
      if (id === "python" && !/^Python 3\./m.test(output)) return null;
      if (id === "node" && !/^v\d+\./m.test(output)) return null;
      return (
        output
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.slice(0, 160) ?? null
      );
    } catch {
      return null;
    }
  }

  function check(): Promise<SetupSnapshot> {
    if (checking) return checking;
    checking = (async () => {
      await deps.refresh();
      const tools = await Promise.all(
        SETUP_TOOLS.map(async ({ id }) => {
          const [version, command] = await Promise.all([probe(id), plan(id)]);
          return {
            id,
            installed: version !== null,
            version,
            installCommand: command?.display ?? null,
            help:
              id === "codex" && !command
                ? "Install Node.js first, then recheck to enable the Codex installer."
                : !command
                  ? "Use the official setup guide, then return here and recheck."
                  : "This downloads software to your computer. The installer may ask for operating system permission.",
          };
        }),
      );
      return { tools, install: install ? { ...install } : null };
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  async function installTool(value: unknown): Promise<SetupInstallStatus> {
    if (!SETUP_TOOLS.some(({ id }) => id === value))
      throw new Error("Unknown setup tool.");
    if (install?.state === "running")
      throw new Error("Another installer is already running.");
    const id = value as SetupToolId;
    install = { tool: id, state: "running", output: "Checking your computer…" };
    try {
      await deps.refresh();
      if (await probe(id)) {
        install = {
          tool: id,
          state: "succeeded",
          output: "Already installed.",
        };
        return { ...install };
      }
      const command = await plan(id);
      if (!command)
        throw new Error(
          "Use the official setup guide for this tool, then recheck.",
        );
      install.output = "Downloading and installing…";
      await deps.run(command, 10 * 60_000, (output) => {
        if (install) install.output = output;
      });
      await deps.refresh();
      if (!(await probe(id)))
        throw new Error(
          "The installer finished, but the tool is not available yet. Restart Codara Studio, then recheck. If it is still missing, use the official setup guide.",
        );
      install = {
        tool: id,
        state: "succeeded",
        output: "Installed and verified. Open a new terminal to use it.",
      };
    } catch (error) {
      install = {
        tool: id,
        state: "failed",
        output: (error as Error).message.slice(-12_000),
      };
    }
    return { ...install };
  }

  return {
    check,
    installTool,
    installStatus: () => (install ? { ...install } : null),
  };
}

export const setupService = createSetupService({
  platform: process.platform,
  resolve: resolveBinary,
  run: runSetupCommand,
  refresh: async () => {
    await refreshEnrichedPath();
    clearResolverCache();
  },
});
