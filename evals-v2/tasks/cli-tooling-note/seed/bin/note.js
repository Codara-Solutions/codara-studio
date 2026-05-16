#!/usr/bin/env node

const args = process.argv.slice(2);

function main() {
  if (args[0] !== "add") {
    console.error("usage: note add --title T --body B");
    process.exit(1);
  }
  const title = args[1];
  const body = args[2];
  console.log(JSON.stringify({ title, body }));
}

main();

