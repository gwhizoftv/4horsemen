import type { Decision, Observation } from "./steps.js";
import type { StartState, CursorState } from "./state.js";

// Simplified decide for Stage A
export const decide = (
  observations: readonly Observation[],
  startState: StartState,
  cursors: CursorState
): readonly Decision[] => {
  void startState;
  void cursors;
  const decisions: Decision[] = [];
  
  for (const obs of observations) {
    if (obs.satisfied) {
      decisions.push({ type: "advance", stepId: obs.stepId });
    } else {
      decisions.push({ type: "reissue", agent: obs.agent, outstanding: obs.outstanding });
    }
  }
  
  return decisions;
};
