import { evaluateEvidence } from "./evidence.js";
import { decide } from "./machine.js";
import { clearCompleteFile, readCompleteFile } from "./action.js";
import { setupMirror, fetchOriginRef } from "./mirror.js";
import { verifyFinalization } from "./finalization.js";
import { resolveIssueRoot } from "./paths.js";
import { StartState, CursorState, appendJournal, updateCursors } from "./state.js";
import { spawnSync } from "node:child_process";

export const runLoop = async (
  coordRoot: string,
  startState: StartState,
  cursors: CursorState,
  cloneRoots: string[],
  originUrls: Record<string, string>
) => {
  for (const agent of startState.originalRoster) {
    const issueRoot = resolveIssueRoot(coordRoot, startState.issue);
    const mirror = setupMirror(coordRoot, startState.issue, cloneRoots);
    
    const completeSha = readCompleteFile(issueRoot);
    if (completeSha) {
       const fetchRes = fetchOriginRef(mirror, originUrls[agent] ?? "", `issue-${startState.issue}/${agent}`);
       if (fetchRes === "success") {
         const obs = evaluateEvidence(mirror, { actionId: "test", agent, task: "", inputs: [], requiredPath: "" }, "test", completeSha);
         const decisions = decide([obs], startState, cursors);
         
         for (const dec of decisions) {
           if (dec.type === "advance" && dec.stepId) {
             clearCompleteFile(issueRoot);
             cursors[agent] = dec.stepId;
             updateCursors(coordRoot, startState.issue, cursors);
             appendJournal(coordRoot, startState.issue, { timestamp: Date.now().toString(), action: "advance", payload: { agent, stepId: dec.stepId } });
           } else if (dec.type === "reissue") {
             clearCompleteFile(issueRoot);
           }
         }
       }
    }
  }
};

export const finalizeR7 = (coordRoot: string, issue: number, consensusSha: string, finalSha: string, checkArgv: string[]) => {
  const ver = verifyFinalization({ root: coordRoot, issue, consensusSha, finalSha });
  if (!ver.ok) throw new Error("Finalization failed: " + ver.reason);
  
  const cmd = checkArgv[0];
  if (!cmd) throw new Error("Invalid checkArgv");
  
  const res = spawnSync(cmd, checkArgv.slice(1));
  if (res.status !== 0) {
    throw new Error("Check failed, blocking PR creation");
  }
};
