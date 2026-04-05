const { spawn } = require("child_process");
const path = require("path");

const cliPath = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "electron-vite",
  "bin",
  "electron-vite.js"
);

const env = { ...process.env };
if (Object.prototype.hasOwnProperty.call(env, "ELECTRON_RUN_AS_NODE")) {
  delete env.ELECTRON_RUN_AS_NODE;
}

const child = spawn(process.execPath, [cliPath, "dev"], {
  stdio: "inherit",
  env,
  shell: false
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
