#!/usr/bin/env node
"use strict";

// A workspace opens its whole tree to a paired phone: files, terminals and
// agents. The September 2026 review found that a phone could add the home
// folder itself (and so read ~/.ssh, the remote-access private key and Pi
// logins) because workspaces.add only required the folder to be inside home.
// phoneWorkspaceRefusal (src/main/remote-access/local-policy.ts) now refuses
// disk roots, the home folder, Codara's own home, and the folders where tools
// keep settings and sign-ins. This suite drives that policy and checks that
// the phone's add path calls it before anything is saved.
//
//   node scripts/test-remote-access-workspace-roots.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

async function loadPolicy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-workspace-roots-"));
  const outfile = path.join(dir, "local-policy.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "remote-access", "local-policy.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

async function main() {
  const { phoneWorkspaceRefusal } = await loadPolicy();
  const home = path.join(path.parse(process.cwd()).root, "Users", "someone");
  const codaraHome = path.join(home, ".codarastudio");
  const posix = { home, codaraHome, platform: "linux" };
  const refused = (target, context = posix) =>
    phoneWorkspaceRefusal(target, context) !== null;

  check("a project folder in home is allowed", !refused(path.join(home, "code", "app")));
  check("a folder directly in home is allowed", !refused(path.join(home, "Documents")));
  check(
    "a dotted name below the top level is still a project folder",
    !refused(path.join(home, "code", ".github")),
  );
  check("the home folder itself is refused", refused(home));
  check("a disk root is refused", refused(path.parse(home).root));
  check("~/.ssh is refused", refused(path.join(home, ".ssh")));
  check("a folder inside ~/.aws is refused", refused(path.join(home, ".aws", "sso")));
  check("~/.claude is refused", refused(path.join(home, ".claude")));
  check("Codara's own home is refused", refused(codaraHome));
  check("the remote-access key folder is refused", refused(path.join(codaraHome, "remote")));

  const customCodaraHome = path.join(home, "code", "studio-home");
  check(
    "a custom Codara home outside the dot folders is refused",
    refused(customCodaraHome, { ...posix, codaraHome: customCodaraHome }),
  );
  check(
    "a folder that contains a custom Codara home is refused",
    refused(path.join(home, "code"), { ...posix, codaraHome: customCodaraHome }),
  );
  check(
    "a sibling of a custom Codara home is allowed",
    !refused(path.join(home, "code", "app"), { ...posix, codaraHome: customCodaraHome }),
  );

  check(
    "~/Library is refused on macOS, whatever its case",
    refused(path.join(home, "Library"), { ...posix, platform: "darwin" }) &&
      refused(path.join(home, "library", "Keychains"), { ...posix, platform: "darwin" }),
  );
  check(
    "a Library project folder is allowed where the system does not own that name",
    !refused(path.join(home, "Library"), posix),
  );
  check(
    "AppData is refused on Windows",
    refused(path.join(home, "AppData", "Roaming"), { ...posix, platform: "win32" }),
  );

  const message = phoneWorkspaceRefusal(home, posix);
  check(
    "the refusal is a sentence the phone can show",
    typeof message === "string" && message.length > 0 && !message.includes("\u2014"),
    message,
  );

  const production = fs.readFileSync(
    path.join(ROOT, "src", "main", "remote-access", "production.ts"),
    "utf8",
  );
  const start = production.indexOf("async function addWorkspaceForRemote(");
  const body = production.slice(start, production.indexOf("\n}\n", start));
  const refusalAt = body.indexOf("phoneWorkspaceRefusal(selected.path");
  check(
    "workspaces.add checks the policy before it saves anything",
    start !== -1 &&
      refusalAt !== -1 &&
      body.includes("if (refusal) throw new Error(refusal);") &&
      refusalAt < body.indexOf("saveState(") &&
      refusalAt < body.indexOf("setAllowedRoots("),
  );

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
