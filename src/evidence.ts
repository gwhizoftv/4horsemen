import { readBlob, type Mirror } from "./mirror.js";
import { AnyArtifactSchema } from "./protocol.js";
import type { InternalAction } from "./action.js";
import type { Observation } from "./steps.js";

// Simplified evaluateEvidence for Stage A
export const evaluateEvidence = (
  mirror: Mirror,
  action: InternalAction,
  stepId: string,
  submissionSha: string
): Observation => {
  const blob = readBlob(mirror, submissionSha, action.requiredPath);
  
  if (!blob) {
    return {
      stepId,
      agent: action.agent,
      satisfied: false,
      outstanding: [`File ${action.requiredPath} is missing in commit ${submissionSha}`]
    };
  }

  try {
    const text = blob.toString("utf8").trim();
    let jsonStr = text;
    if (text.startsWith("```json")) {
      jsonStr = text.replace(/^```json\\n?/, "").replace(/\\n?```$/, "");
    }
    
    const parsed = AnyArtifactSchema.safeParse(JSON.parse(jsonStr));
    if (!parsed.success) {
      return {
        stepId,
        agent: action.agent,
        satisfied: false,
        outstanding: ["Artifact validation failed"]
      };
    }
    
    return {
      stepId,
      agent: action.agent,
      satisfied: true,
      outstanding: []
    };
  } catch {
    return {
      stepId,
      agent: action.agent,
      satisfied: false,
      outstanding: ["Failed to parse file content"]
    };
  }
};
