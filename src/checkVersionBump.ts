import { checkVersionBump } from "./versionBump.js";

const result = checkVersionBump(process.cwd(), {
  baseRef: process.env.COORD_VERSION_BASE_REF ?? "origin/main"
});
process.stdout.write(`${result.detail}\n`);
process.exitCode = result.ok ? 0 : 1;
