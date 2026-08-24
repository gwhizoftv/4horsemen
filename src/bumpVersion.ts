import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bumpManifestSource } from "./versionBump.js";

/**
 * Advance `package.json` by one patch and print `<from> -> <to>`.
 *
 * Called by `.github/workflows/version-bump-on-merge.yml` after a merge lands on
 * `main`, which is the only place the pre-1.0 `0.0.N` advance happens. Nothing
 * on an issue branch runs this: branches sit at `main`'s version for the whole
 * protocol run.
 *
 * It writes the manifest and stops there. Committing and pushing stay in the
 * workflow, where the retry that re-reads `origin/main` lives — an entry point
 * that also committed could not be re-run safely inside that retry.
 */
try {
  const path = join(process.cwd(), "package.json");
  const bumped = bumpManifestSource(readFileSync(path, "utf8"));
  writeFileSync(path, bumped.source);
  process.stdout.write(`${bumped.from} -> ${bumped.to}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
