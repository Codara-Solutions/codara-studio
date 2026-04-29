export type ShellId = string;

export interface ShellInfo {
  id: ShellId;
  label: string;
  exe: string;
  args: string[];
  family: "pwsh" | "powershell" | "cmd" | "bash" | "zsh" | "fish" | "sh" | "wsl" | "other";
}

export interface Worker {
  id: string;
  name?: string;
  shellId: ShellId;
}

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  color: string;
  workers: Worker[];
}

export interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  ext?: string;
}

export interface FsFileContent {
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
}

export interface GitGraph {
  isRepo: boolean;
  branch?: string;
  branches: GitBranch[];
  remoteBranches: string[];
  lines: string[];
  error?: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
}
