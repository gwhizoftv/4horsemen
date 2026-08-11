import { pathToFileURL } from "node:url";

import { defaultCliDeps, EXIT_FAILURE, runCli } from "./cli.js";

/**
 * Process entry. Import-safe: it does nothing unless run directly, which keeps
 * the CLI module testable without spawning a process or touching exit codes.
 */
export const main = async (argv: readonly string[]): Promise<number> => {
  const deps = defaultCliDeps({
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  });

  try {
    return await runCli(argv, deps);
  } catch (error) {
    process.stderr.write(`coord: ${error instanceof Error ? error.message : String(error)}\n`);

    return EXIT_FAILURE;
  }
};

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
