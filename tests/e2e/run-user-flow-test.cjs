const { spawn } = require("node:child_process");

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") env[key] = value;
}
env.SPARK_E2E_USER_FLOW = "1";

const child = spawn(process.execPath, [require.resolve("@playwright/test/cli"), "test", "tests/e2e/user-flow.spec.ts"], {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
