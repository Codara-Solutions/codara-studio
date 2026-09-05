const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const vm = require("node:vm");
const { patchSource } = require("./patch-macos-keychain.cjs");

async function main() {
  const file = require.resolve("app-builder-lib/out/codeSign/macCodeSign.js");
  const source = fs.readFileSync(file, "utf8");
  assert.equal(patchSource(source), source, "postinstall must apply the signing fix");
  assert.throws(() => patchSource("unexpected upstream module"), /signing code changed/);

  const commands = [];
  const localRequire = createRequire(file);
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    process: { env: { TRAVIS: "true" }, platform: "darwin" },
    require(name) {
      if (name === "builder-util") return {
        ...localRequire(name),
        exec: async (command, args) => {
          assert.equal(command, "/usr/bin/security");
          commands.push(args);
          return "";
        },
      };
      if (name === "./codesign") return { importCertificate: async (link) => link };
      return localRequire(name);
    },
  }, { filename: file });
  await exports.createKeychain({
    currentDir: "/mock-codara-signing", tmpDir: {},
    cscLink: "/mock-app.p12", cscKeyPassword: "app-certificate-password",
    cscILink: "/mock-installer.p12", cscIKeyPassword: "installer-certificate-password",
  });
  const keychainPassword = commands.find(([name]) => name === "create-keychain")[2];
  const imports = commands.filter(([name]) => name === "import");
  assert.equal(imports.length, 2);
  assert.equal(imports[0][imports[0].indexOf("-P") + 1], "app-certificate-password");
  assert.equal(imports[1][imports[1].indexOf("-P") + 1], "installer-certificate-password");
  const access = commands.filter(([name]) => name === "set-key-partition-list");
  assert.equal(access.length, 2);
  for (const args of access) assert.equal(args[args.indexOf("-k") + 1], keychainPassword);
  assert.notEqual(keychainPassword, "app-certificate-password");
  console.log("PASS macOS certificate import and keychain access use their respective passwords");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
