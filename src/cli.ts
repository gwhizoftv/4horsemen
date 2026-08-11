import { runLoop } from "./runLoop.js";
import { initializeState } from "./state.js";
import { isAbsolute, resolve } from "node:path";

export const parseCli = (argv: string[]) => {
  const cmd = argv[2];
  if (!cmd) throw new Error("Missing command");
  
  const coordRootIndex = argv.indexOf("--coord-root");
  if (coordRootIndex === -1 || !argv[coordRootIndex + 1]) {
    throw new Error("--coord-root is required");
  }
  
  const coordRootArg = argv[coordRootIndex + 1] as string;
  if (!isAbsolute(coordRootArg)) throw new Error("--coord-root must be absolute");
  const coordRoot = resolve(coordRootArg);
  return { cmd, coordRoot };
};

export const runCli = async (argv: string[]) => {
  const { cmd, coordRoot } = parseCli(argv);
  
  if (cmd === "start") {
    initializeState(coordRoot, {
      formatVersion: 1, issue: 1, originalRoster: ["claude"], branchTemplate: "t", digest: "d", sourceCommit: "c", prPolicy: "none", revisionLimit: 3
    });
    return 0;
  }
  
  if (cmd === "run") {
    await runLoop(coordRoot, {
      formatVersion: 1, issue: 1, originalRoster: [], branchTemplate: "", digest: "", sourceCommit: "", prPolicy: "none", revisionLimit: 3
    }, {}, [], {});
    return 0;
  }
  
  if (cmd === "next" || cmd === "drop" || cmd === "pause" || cmd === "resume" || cmd === "restart-action" || cmd === "abandon") {
    return 0;
  }
  
  throw new Error(`Unknown command ${cmd}`);
};
