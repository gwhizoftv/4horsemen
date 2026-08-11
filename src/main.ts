/** Process entry — implement coord CLI in issue 1. */
const run = async (): Promise<number> => {
  const [cmd] = process.argv.slice(2);
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    process.stdout.write(
      "coord — workflow driver (stub)\n\nUsage: coord <start|run|next|...>\n"
    );
    return 0;
  }
  process.stderr.write(`coord: '${cmd}' not implemented yet (issue 1)\n`);
  return 2;
};

run().then((code) => process.exit(code));
