const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const mode = process.argv[2];
if (mode === "build") {
  for (const script of [
    "compile:globe",
    "compile:fast-paste",
    "compile:text-monitor",
    "compile:audio-tap",
    "download:brand-fonts",
    "build:renderer",
  ]) {
    const result = spawnSync("npm", ["run", script], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, VITE_LOCAL_FLOW: "1" },
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  const result = spawnSync(
    path.join(root, "node_modules/.bin/electron-builder"),
    [
      "--config",
      "electron-builder.local-flow.json",
      "--mac",
      "--arm64",
      "--dir",
      "--publish",
      "never",
    ],
    { cwd: root, stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } }
  );
  process.exit(result.status || 0);
} else if (mode === "start") {
  const secrets = JSON.parse(fs.readFileSync(path.join(root, "cloudflare/.secrets.json"), "utf8"));
  const installed = "/Applications/Local Flow.app/Contents/MacOS/Local Flow";
  const executable = fs.existsSync(installed)
    ? installed
    : path.join(root, "dist/local-flow/mac-arm64/Local Flow.app/Contents/MacOS/Local Flow");
  const child = spawn(executable, [], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, LOCAL_FLOW: "1", LOCAL_FLOW_ACCESS_TOKEN: secrets.ACCESS_TOKEN },
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.unref();
} else {
  console.error("Use: node scripts/local-flow.cjs build|start");
  process.exit(1);
}
