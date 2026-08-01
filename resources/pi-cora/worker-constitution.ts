import { lstatSync, readFileSync } from "node:fs";

const WORKER_CONSTITUTION_MAX_BYTES = 24 * 1024;

export function loadWorkerConstitutionBlock(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = env.CODARA_PI_WORKER_CONSTITUTION_PATH?.trim();
  if (!path) return "";
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size > WORKER_CONSTITUTION_MAX_BYTES
  ) {
    throw new Error("Cora's immutable worker constitution file is invalid.");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > WORKER_CONSTITUTION_MAX_BYTES) {
    throw new Error("Cora's immutable worker constitution file is invalid.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Cora's immutable worker constitution file is invalid.");
  }
}

export function appendPiWorkerConstitution(
  systemPrompt: string,
  block: string,
): string {
  return block ? `${systemPrompt}\n\n${block}` : systemPrompt;
}
