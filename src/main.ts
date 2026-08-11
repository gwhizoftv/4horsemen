import { pathToFileURL } from "node:url";
import { runCli } from "./cli.js";

export const main = async (argv = process.argv.slice(2)): Promise<number> => runCli(argv);

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`coord: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
