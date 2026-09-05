const fs = require("node:fs");

// Backport https://github.com/electron-userland/electron-builder/pull/10101
// until the fix ships on the stable builder line. Certificate import and
// keychain access require different passwords.
const replacements = [
  ["importCerts(keychainFile, certPaths, cscPasswords)", "importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)"],
  ["async function importCerts(keychainFile, paths, keyPasswords)", "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword)"],
  ['"-s", "-k", password, keychainFile]', '"-s", "-k", keychainPassword, keychainFile]'],
];

function patchSource(source) {
  if (replacements.every(([, after]) => source.split(after).length === 2)) return source;
  if (!replacements.every(([before]) => source.split(before).length === 2)) {
    throw new Error("electron-builder signing code changed; review the keychain backport before packaging");
  }
  for (const [before, after] of replacements) source = source.replace(before, after);
  return source;
}

if (require.main === module) {
  const file = require.resolve("app-builder-lib/out/codeSign/macCodeSign.js");
  const source = fs.readFileSync(file, "utf8");
  const patched = patchSource(source);
  if (patched !== source) fs.writeFileSync(file, patched);
}

module.exports = { patchSource };
