import { runCli } from "./cli.js";

const main = async (): Promise<never> => {
  const result = await runCli(process.argv.slice(2));
  if (result.message) {
    if (result.code === 0) {
      process.stdout.write(result.message + "\n");
    } else {
      process.stderr.write(result.message + "\n");
    }
  }
  process.exit(result.code);
};

main();
