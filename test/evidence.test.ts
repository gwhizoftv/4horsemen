import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { evaluateEvidence } from "../src/evidence.js";
import { initMirror, fetchAgentBranch } from "../src/mirror.js";
import type { InternalAction } from "../src/action.js";
import type { StepId, EvidenceId } from "../src/steps.js";

const AGENT = "testagent";
const BRANCH = `issue-1/${AGENT}`;
const SESSION = "issue-1:" + "a".repeat(40);
let BASELINE: string;
const DIGEST = "sha256:abc";
const DIGEST_SCHEME = "sha256";

let tmp: string;
let coordRoot: string;
let commitJoinGood: string;
let commitJoinBadSession: string;
let commitPlanGood: string;
let commitPlanBad: string;
let commitImplGood: string;
let commitImplBadPin: string;
let offBranchSha: string;

function git(cwd: string, ...args: string[]): string {
  return execSync("git " + args.map(a => `'${a}'`).join(" "), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

function makeAction(overrides: Partial<InternalAction> & { stepId: StepId; evidenceId: EvidenceId }): InternalAction {
  return {
    actionId: "test-action",
    agent: AGENT,
    requiredPath: "",
    issue: 1,
    attempt: 1,
    inputCommits: {},
    outstanding: [],
    ...overrides,
  };
}

function addAndCommit(workDir: string, path: string, content: string, msg: string): string {
  const full = join(workDir, ...path.split("/"));
  const dir = full.substring(0, full.lastIndexOf("/"));
  execSync(`mkdir -p "${dir}"`, { encoding: "utf8" });
  writeFileSync(full, content);
  git(workDir, "add", ".");
  git(workDir, "commit", "-m", msg);
  return git(workDir, "rev-parse", "HEAD");
}

const joinPath = `.coordination/issue-1/${AGENT}/join.json`;
const planPath = `.coordination/issue-1/${AGENT}/plan.md`;
const implPath = `.coordination/issue-1/${AGENT}/implementation-ready.json`;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "evidence-test-"));
  const originDir = join(tmp, "origin.git");
  const workDir = join(tmp, "work");
  coordRoot = join(tmp, "coord");

  execSync(`git init --bare '${originDir}'`, { encoding: "utf8" });
  execSync(`git clone '${originDir}' '${workDir}'`, { encoding: "utf8" });

  git(workDir, "checkout", "-b", BRANCH);

  // Initial commit so we have a baseline
  BASELINE = addAndCommit(workDir, "init.txt", "init", "init");

  // Good join
  const joinGood = JSON.stringify({
    type: "join",
    issueSessionId: SESSION,
    agent: AGENT,
    baselineSha: BASELINE,
    automationDigest: DIGEST,
    automationDigestScheme: DIGEST_SCHEME,
    createdAt: new Date().toISOString(),
  });
  commitJoinGood = addAndCommit(workDir, joinPath, joinGood, "join good");

  // Bad join (wrong session)
  const joinBad = JSON.stringify({
    type: "join",
    issueSessionId: "issue-1:" + "f".repeat(40),
    agent: AGENT,
    baselineSha: BASELINE,
    automationDigest: DIGEST,
    automationDigestScheme: DIGEST_SCHEME,
    createdAt: new Date().toISOString(),
  });
  commitJoinBadSession = addAndCommit(workDir, joinPath, joinBad, "join bad session");

  // Good plan
  const planGood = [
    "# Plan",
    "## Exact file map",
    "files here",
    "## Required behavior",
    "behavior here",
    "## Alternatives rejected",
    "none",
    "## Risks and mitigations",
    "none",
    "## Conclusion",
    "done",
  ].join("\n");
  commitPlanGood = addAndCommit(workDir, planPath, planGood, "plan good");

  // Bad plan (missing section)
  const planBad = "# Plan\n## Exact file map\nfiles\n## Required behavior\nbeh\n";
  commitPlanBad = addAndCommit(workDir, planPath, planBad, "plan bad");

  // Implementation with valid pin (reuse earlier commit as the pinned impl commit)
  const implPinSha = commitPlanBad;
  const implGood = JSON.stringify({
    type: "implementation-ready",
    issueSessionId: SESSION,
    agent: AGENT,
    implementationCommitSha: implPinSha,
    baselineSha: BASELINE,
    fileMap: ["src/foo.ts"],
    createdAt: new Date().toISOString(),
  });
  commitImplGood = addAndCommit(workDir, implPath, implGood, "impl-good");

  // Implementation with non-existent pin SHA → triggers pin-not-found
  const implBad = JSON.stringify({
    type: "implementation-ready",
    issueSessionId: SESSION,
    agent: AGENT,
    implementationCommitSha: "c".repeat(40),
    baselineSha: BASELINE,
    fileMap: ["src/foo.ts"],
    createdAt: new Date().toISOString(),
  });
  commitImplBadPin = addAndCommit(workDir, implPath, implBad, "impl-bad-pin");

  git(workDir, "push", "origin", BRANCH);

  // Off-branch commit
  git(workDir, "checkout", "-b", "other-branch");
  const offSha = addAndCommit(workDir, "off.txt", "off", "off branch");
  git(workDir, "push", "origin", "other-branch");
  offBranchSha = offSha;

  initMirror(coordRoot, originDir);
  fetchAgentBranch(coordRoot, 1, AGENT);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("evaluateEvidence join-published", () => {
  it("passes with valid join JSON", () => {
    const action = makeAction({ stepId: "R1.join", evidenceId: "join-published", requiredPath: joinPath });
    const result = evaluateEvidence(coordRoot, action, commitJoinGood, SESSION, BASELINE, DIGEST, DIGEST_SCHEME, [AGENT]);
    expect(result.ok).toBe(true);
  });

  it("fails with missing file", () => {
    const action = makeAction({ stepId: "R1.join", evidenceId: "join-published", requiredPath: "nonexistent.json" });
    const result = evaluateEvidence(coordRoot, action, commitJoinGood, SESSION, BASELINE, DIGEST, DIGEST_SCHEME, [AGENT]);
    expect(result.ok).toBe(false);
    expect(result.outstanding.some(o => o.code === "missing-artifact")).toBe(true);
  });

  it("fails with wrong session", () => {
    const action = makeAction({ stepId: "R1.join", evidenceId: "join-published", requiredPath: joinPath });
    const result = evaluateEvidence(coordRoot, action, commitJoinBadSession, SESSION, BASELINE, DIGEST, DIGEST_SCHEME, [AGENT]);
    expect(result.ok).toBe(false);
    expect(result.outstanding.some(o => o.code === "session-mismatch")).toBe(true);
  });
});

describe("evaluateEvidence plan-published", () => {
  it("passes with all required sections", () => {
    const action = makeAction({ stepId: "R2.plan", evidenceId: "plan-published", requiredPath: planPath });
    const result = evaluateEvidence(coordRoot, action, commitPlanGood, SESSION, BASELINE, DIGEST, DIGEST_SCHEME, [AGENT]);
    expect(result.ok).toBe(true);
  });

  it("fails with missing section", () => {
    const action = makeAction({ stepId: "R2.plan", evidenceId: "plan-published", requiredPath: planPath });
    const result = evaluateEvidence(coordRoot, action, commitPlanBad, SESSION, BASELINE, DIGEST, DIGEST_SCHEME, [AGENT]);
    expect(result.ok).toBe(false);
    expect(result.outstanding.some(o => o.code === "missing-section")).toBe(true);
  });
});

describe("evaluateEvidence implementation-pinned", () => {
  it("passes with valid implementation pin", () => {
    const action = makeAction({ stepId: "R4.implement", evidenceId: "implementation-pinned", requiredPath: implPath });
    const result = evaluateEvidence(coordRoot, action, commitImplGood, SESSION, BASELINE, DIGEST, DIGEST_SCHEME, [AGENT]);
    expect(result.ok).toBe(true);
  });

  it("fails when pin SHA does not exist", () => {
    const action = makeAction({ stepId: "R4.implement", evidenceId: "implementation-pinned", requiredPath: implPath });
    const result = evaluateEvidence(coordRoot, action, commitImplBadPin, SESSION, BASELINE, DIGEST, DIGEST_SCHEME, [AGENT]);
    expect(result.ok).toBe(false);
    expect(result.outstanding.some(o => o.code === "pin-not-found")).toBe(true);
  });
});

describe("submission not on branch", () => {
  it("returns outstanding submission-not-on-branch", () => {
    const action = makeAction({ stepId: "R1.join", evidenceId: "join-published", requiredPath: joinPath });
    const result = evaluateEvidence(coordRoot, action, offBranchSha, SESSION, BASELINE, DIGEST, DIGEST_SCHEME, [AGENT]);
    expect(result.ok).toBe(false);
    expect(result.outstanding.some(o => o.code === "submission-not-on-branch")).toBe(true);
  });
});
