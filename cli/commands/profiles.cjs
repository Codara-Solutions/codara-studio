"use strict";

const { rpc } = require("../lib/rpc.cjs");
const { c, fail } = require("../lib/ui.cjs");

function printProfiles(profiles) {
  for (const profile of profiles) {
    const active = profile.isDefault ? c.green("●") : c.dim("○");
    const description = profile.description ? c.dim(`  ${profile.description}`) : "";
    console.log(`${active} ${c.bold(profile.name)}  ${c.dim(profile.id)}${description}`);
  }
}

async function profile(args, flags) {
  const action = args[0] ?? "list";
  if (action === "list") {
    const result = await rpc(flags, "profiles.list", {});
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    printProfiles(result.profiles ?? []);
    return;
  }
  if (action === "create") {
    const name = args.slice(1).join(" ").trim();
    if (!name) fail("usage: cora profile create <name> [--description TEXT --instructions TEXT]");
    const result = await rpc(flags, "profiles.create", {
      name,
      ...(flags.description ? { description: flags.description } : {}),
      ...(flags.instructions ? { instructions: flags.instructions } : {}),
    });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} created ${c.bold(result.profile.name)}  ${c.dim(result.profile.id)}`);
    console.log(c.dim(`identity: ${result.profile.identityPath}`));
    return;
  }
  if (action === "use") {
    const reference = args.slice(1).join(" ").trim();
    if (!reference) fail("usage: cora profile use <name|id>");
    const result = await rpc(flags, "profiles.use", { profile: reference });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} ${c.bold(result.profile.name)} is now the default Cora profile`);
    return;
  }
  fail("usage: cora profile list | create <name> | use <name|id>");
}

module.exports = { profile };
