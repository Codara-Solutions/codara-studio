// Imported first by index.ts (after the AppImage guard), so it wraps
// child_process before any module takes a reference to its functions. The
// default import is the module object itself; a namespace import would be a
// read-only copy in the bundle.
//
// CODARA_SPAWN_CENSUS=<file> counts every child process the main process
// starts, by program and by the source lines that asked for it, and rewrites
// <file> as JSON every few seconds and at exit. Without the variable nothing
// is wrapped and nothing is counted. scripts/measure-spawns.cjs reads it and,
// on a build made with CODARA_MAIN_SOURCEMAP=1, names the source lines.
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { promisify } from "node:util";

const WRITE_EVERY_MS = 5_000;
// Raw frames: the bundle is loaded before source maps could be turned on, so
// the script maps them and drops the frames that only forward a spawn.
const CALLER_FRAMES = 10;

interface Census {
  startedAt: number;
  total: number;
  byProgram: Record<string, number>;
  byCaller: Record<string, number>;
  perSecond: Record<string, number>;
}

/** `git status` for a git read, the program name otherwise. */
export function spawnLabel(file: string, args: readonly unknown[]): string {
  const program = basename(String(file).trim().split(/\s+/)[0] ?? "").replace(/\.exe$/i, "");
  if (program === "git" || program === "gh") {
    const words = args.map(String);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word === "-C" || word === "-c") {
        i += 1;
        continue;
      }
      if (word.startsWith("-")) continue;
      if (program === "gh" && words[i + 1] && !words[i + 1].startsWith("-")) return `gh ${word} ${words[i + 1]}`;
      return `${program} ${word}`;
    }
  }
  if (program === "ps" && args.length > 0) return `ps ${String(args[0])}`;
  return program;
}

/** The stack frames above the spawn, as `path:line:column`, nearest first. */
export function spawnCaller(stack: string): string {
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    if (/spawn-census|\(node:|at node:/.test(line)) continue;
    const match = /\(?((?:file:\/\/)?[^\s()]+):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!match) continue;
    frames.push(`${match[1]}:${match[2]}:${match[3]}`);
    if (frames.length >= CALLER_FRAMES) break;
  }
  return frames.join(" < ") || "unknown";
}

function install(target: string): void {
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 40);
  const census: Census = { startedAt: Date.now(), total: 0, byProgram: {}, byCaller: {}, perSecond: {} };
  const record = (file: unknown, args: unknown): void => {
    const list = Array.isArray(args) ? args : [];
    const label = spawnLabel(String(file ?? ""), list);
    const caller = spawnCaller(new Error().stack ?? "");
    const second = String(Math.floor((Date.now() - census.startedAt) / 1000));
    census.total += 1;
    census.byProgram[label] = (census.byProgram[label] ?? 0) + 1;
    census.byCaller[`${label} @ ${caller}`] = (census.byCaller[`${label} @ ${caller}`] ?? 0) + 1;
    census.perSecond[second] = (census.perSecond[second] ?? 0) + 1;
  };
  const write = (): void => {
    try {
      fs.writeFileSync(target, JSON.stringify({ ...census, writtenAt: Date.now() }));
    } catch {
      /* the census is best effort */
    }
  };
  const mutable = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
    const original = mutable[name];
    const wrapped = function (this: unknown, file: unknown, args?: unknown, ...rest: unknown[]) {
      record(name === "fork" ? process.execPath : file, args);
      return original.call(this, file, args, ...rest);
    };
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
    if (typeof custom === "function") {
      Object.defineProperty(wrapped, promisify.custom, {
        value: (file: unknown, args?: unknown, ...rest: unknown[]) => {
          record(file, args);
          return custom(file, args, ...rest);
        },
      });
    }
    mutable[name] = wrapped as never;
  }
  for (const name of ["exec", "execSync"]) {
    const original = mutable[name];
    const wrapped = function (this: unknown, command: unknown, ...rest: unknown[]) {
      const words = String(command ?? "").trim().split(/\s+/);
      record(words[0], words.slice(1));
      return original.call(this, command, ...rest);
    };
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
    if (typeof custom === "function") {
      Object.defineProperty(wrapped, promisify.custom, {
        value: (command: unknown, ...rest: unknown[]) => {
          const words = String(command ?? "").trim().split(/\s+/);
          record(words[0], words.slice(1));
          return custom(command, ...rest);
        },
      });
    }
    mutable[name] = wrapped as never;
  }
  syncBuiltinESMExports();
  setInterval(write, WRITE_EVERY_MS).unref();
  process.on("exit", write);
}

const target = process.env.CODARA_SPAWN_CENSUS;
if (target) install(target);
