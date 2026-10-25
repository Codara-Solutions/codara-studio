"use strict";

// A throwaway SSH machine in Docker for the Machines tests
// (tests/e2e/fixtures/ssh-host): sshd for the user "dev" on a random
// 127.0.0.1 port, key auth with a key made for this run, tmux and a fake
// `claude`. Nothing here touches the user's ~/.ssh or a real server.
//
//   const host = await startSshTestHost({ dir });
//   host.port, host.keyPath, host.exec("tmux ls"), await host.stop();

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const run = promisify(execFile);
const IMAGE = "codara-ssh-test-host:1";
const CONTEXT = path.join(__dirname, "..", "tests", "e2e", "fixtures", "ssh-host");

async function dockerAvailable() {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureImage() {
  try {
    await run("docker", ["image", "inspect", IMAGE], { timeout: 10_000 });
  } catch {
    await run("docker", ["build", "-q", "-t", IMAGE, CONTEXT], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  }
}

async function makeKey(dir) {
  const keyPath = path.join(dir, "id_ed25519");
  fs.rmSync(keyPath, { force: true });
  fs.rmSync(`${keyPath}.pub`, { force: true });
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "codara-test", "-f", keyPath]);
  return keyPath;
}

async function startSshTestHost({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  await ensureImage();
  const keyPath = await makeKey(dir);
  const publicKey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const { stdout } = await run("docker", [
    "run", "-d", "--rm",
    "--memory", "512m", "--cpus", "1", "--pids-limit", "256",
    "-p", "127.0.0.1::22",
    "-e", `AUTHORIZED_KEY=${publicKey}`,
    IMAGE,
  ]);
  const id = stdout.trim();
  const portLine = (await run("docker", ["port", id, "22/tcp"])).stdout.trim().split("\n")[0];
  const port = Number(portLine.slice(portLine.lastIndexOf(":") + 1));
  const exec = async (command) =>
    (await run("docker", ["exec", "-u", "dev", id, "sh", "-c", command], { timeout: 20_000 })).stdout;
  // sshd answers once its host keys exist.
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await run("docker", ["exec", id, "sh", "-c", "pgrep -x sshd >/dev/null && test -s /etc/ssh/ssh_host_ed25519_key"]);
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return {
    id,
    port,
    keyPath,
    user: "dev",
    projectPath: "/home/dev/project",
    exec,
    async stop() {
      await run("docker", ["rm", "-f", id]).catch(() => undefined);
    },
  };
}

module.exports = { dockerAvailable, startSshTestHost, IMAGE };
