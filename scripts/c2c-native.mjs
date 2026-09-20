#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const stateIndex = args.indexOf("--state-dir");
if (stateIndex < 0 || !args[stateIndex + 1]) {
  process.stderr.write("c2c-native requires --state-dir <PLUGIN_DATA>\n");
  process.exit(2);
}
const stateDir = path.resolve(args[stateIndex + 1]);
const forwarded = [...args.slice(0, stateIndex), ...args.slice(stateIndex + 2)];
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "bin", "c2c.js");

const result = spawnSync(process.execPath, [cli, ...forwarded], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    C2C_STATE_DIR: stateDir,
    C2C_PLUGIN_MODE: "1"
  },
  stdio: "inherit",
  windowsHide: true
});

if (result.error) {
  process.stderr.write(result.error.message + "\n");
  process.exit(1);
}
process.exit(result.status ?? 1);
