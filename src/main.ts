import { runCli } from "./cli.js";

export const main = async () => {
  try {
    const code = await runCli(process.argv);
    process.exit(code);
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(err.message);
    }
    process.exit(1);
  }
};

import { fileURLToPath } from "node:url";

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
