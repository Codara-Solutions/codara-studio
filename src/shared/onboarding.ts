export const ONBOARDING_STEPS = [
  "welcome",
  "tools",
  "account",
  "workspace",
  "tour",
  "ready",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingServiceUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No handler registered for ['"]onboarding:[^'"]+['"]/.test(message);
}

export interface OnboardingProgress {
  version: 1;
  step: OnboardingStep;
  dismissed: boolean;
}

export const SETUP_TOOLS = [
  {
    id: "git",
    label: "Git",
    detail: "Saves checkpoints and powers source control and project branches.",
    url: "https://git-scm.com/downloads",
  },
  {
    id: "python",
    label: "Python 3",
    detail: "Lets Codara follow Claude Code activity through its local hooks.",
    url: "https://www.python.org/downloads/",
  },
  {
    id: "node",
    label: "Node.js",
    detail:
      "Runs JavaScript project tools and installs Codex through npm. Cora has its own runtime.",
    url: "https://nodejs.org/en/download",
  },
  {
    id: "claude",
    label: "Claude Code",
    detail:
      "Anthropic's terminal agent. Install this if you want to use Claude.",
    url: "https://code.claude.com/docs/en/setup",
  },
  {
    id: "codex",
    label: "Codex",
    detail:
      "OpenAI's terminal agent. Install this if you want to use your ChatGPT account.",
    url: "https://developers.openai.com/codex/cli/",
  },
] as const;
export type SetupToolId = (typeof SETUP_TOOLS)[number]["id"];
export interface SetupToolStatus {
  id: SetupToolId;
  installed: boolean;
  version: string | null;
  installCommand: string | null;
  help: string;
}
export interface SetupInstallStatus {
  tool: SetupToolId;
  state: "running" | "succeeded" | "failed";
  output: string;
}
export interface SetupSnapshot {
  tools: SetupToolStatus[];
  install: SetupInstallStatus | null;
}

export function normalizeOnboardingProgress(
  value: unknown,
): OnboardingProgress {
  const input = value as Partial<OnboardingProgress> | null;
  return {
    version: 1,
    step:
      input?.version === 1 &&
      ONBOARDING_STEPS.includes(input.step as OnboardingStep)
        ? input.step!
        : "welcome",
    dismissed: input?.version === 1 && input.dismissed === true,
  };
}

export type StudioTourFeature =
  | "cora"
  | "terminal"
  | "browser"
  | "files"
  | "automations"
  | "whiteboard";
export const STUDIO_TOUR: ReadonlyArray<{
  id: StudioTourFeature;
  label: string;
  title: string;
  detail: string;
  task: string;
}> = [
  {
    id: "cora",
    label: "Cora",
    title: "Start with an idea",
    detail:
      "Cora is your project conversation. Describe the outcome, discuss a plan, then let Cora coordinate agents. Your selected account supplies the model access.",
    task: "Open a new chat. Try: Explain this project and suggest a small first improvement. Review the selected mode and model before sending.",
  },
  {
    id: "terminal",
    label: "Terminal",
    title: "A place for commands and agents",
    detail:
      "A terminal runs commands on your computer inside the project folder. Use separate tabs for your app, tests, and agents. Split panes to keep them side by side.",
    task: "Open a terminal and try git --version. Later, use the agent picker to start Claude Code or Codex. Keep a development server running here while you preview it.",
  },
  {
    id: "browser",
    label: "Browser",
    title: "See what you are building",
    detail:
      "The built-in browser keeps websites and your running app beside the code. It does not start a development server for you.",
    task: "Open the browser and enter a URL. For a local app, start its development server in a terminal, then paste the localhost address it prints. Use the inspector to point out something to change.",
  },
  {
    id: "files",
    label: "Files & Git",
    title: "Stay close to the changes",
    detail:
      "The Explorer shows files in the active workspace. Open a file to edit it. Source control shows changes you can review before making a Git commit. Copy branches isolate experiments.",
    task: "Choose a file in the Explorer to read it. After an agent makes a change, inspect its diff in source control before committing. A workspace is a folder, not automatically a Git repository.",
  },
  {
    id: "automations",
    label: "Automations",
    title: "Good work, on repeat",
    detail:
      "Save repeatable workflows and run them manually, on a schedule, or from Git events. Runs let you follow progress and inspect the result.",
    task: "Open Automations and look around. Start with a manual workflow before enabling a schedule. Agent work uses your connected account and its limits.",
  },
  {
    id: "whiteboard",
    label: "Whiteboard",
    title: "Give your ideas some space",
    detail:
      "Use a whiteboard to sketch a flow or organize an idea alongside your code and conversations. Tabs and split panes let you arrange the studio around your task.",
    task: "Open a whiteboard and sketch your first idea. You can return to this guide anytime from Settings > General.",
  },
];
