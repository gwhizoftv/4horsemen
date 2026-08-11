import { describe, it, expect } from "vitest";
import { decide } from "../src/machine.js";

describe("machine", () => {
  it("advances if satisfied", () => {
    const decisions = decide(
      [{ stepId: "s1", agent: "A", satisfied: true, outstanding: [] }],
      { formatVersion: 1, issue: 1, originalRoster: [], branchTemplate: "", digest: "", sourceCommit: "", prPolicy: "none", revisionLimit: 3 },
      {}
    );
    expect(decisions).toEqual([{ type: "advance", stepId: "s1" }]);
  });
  
  it("reissues if unsatisfied", () => {
    const decisions = decide(
      [{ stepId: "s1", agent: "A", satisfied: false, outstanding: ["err"] }],
      { formatVersion: 1, issue: 1, originalRoster: [], branchTemplate: "", digest: "", sourceCommit: "", prPolicy: "none", revisionLimit: 3 },
      {}
    );
    expect(decisions).toEqual([{ type: "reissue", agent: "A", outstanding: ["err"] }]);
  });
});
