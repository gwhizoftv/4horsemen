import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liftCloneAgentsProtocol, writeCloneAgentsProtocol } from "../src/agentsProtocol.js";
import { makeAgentClonesBaseReady, prepareAgentIssueBranches } from "../src/prepareAgentBranch.js";
import { git, repoRoot, tryGit } from "./support/workspaceFixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const skipWorktree = (clone: string): boolean => git(clone, "ls-files", "-v", "--", "AGENTS.md").startsWith("S");

const seedClone = (): { clone: string; baseline: string; earlier: string } => {
  const workspace = mkdtempSync(join(tmpdir(), "coord-prepare-branch-"));
  roots.push(workspace);
  const product = join(workspace, "app");
  const origin = join(workspace, "origin.git");
  const clone = join(workspace, "app-claude");
  mkdirSync(product, { recursive: true });
  git(product, "init", "-q", "--initial-branch=main");
  git(product, "config", "user.name", "Fixture");
  git(product, "config", "user.email", "fixture@example.com");
  writeFileSync(join(product, "AGENTS.md"), "# product v1\n");
  git(product, "add", "AGENTS.md");
  git(product, "commit", "-qm", "v1");
  const earlier = git(product, "rev-parse", "HEAD");
  writeFileSync(join(product, "AGENTS.md"), "# product v2\n");
  git(product, "add", "AGENTS.md");
  git(product, "commit", "-qm", "v2");
  const baseline = git(product, "rev-parse", "HEAD");
  git(product, "clone", "--bare", "-q", product, origin);
  mkdirSync(clone, { recursive: true });
  git(clone, "clone", "-q", origin, clone);
  git(clone, "config", "user.name", "Fixture");
  git(clone, "config", "user.email", "fixture@example.com");
  git(clone, "checkout", "-q", "--detach", earlier);
  git(clone, "checkout", "-q", "-B", "main", earlier);
  writeCloneAgentsProtocol({
    clone,
    installRoot: repoRoot,
    options: { dryRun: false, log: () => undefined, changes: [] }
  });
  return { clone, baseline, earlier };
};

describe("prepareAgentIssueBranches", () => {
  it("checks out issue-N/agent at the baseline around skip-worktree AGENTS.md and restores the overlay", () => {
    const { clone, baseline } = seedClone();
    expect(skipWorktree(clone)).toBe(true);
    expect(tryGit(clone, "checkout", "-q", "-B", "issue-9/claude", baseline).exitCode).not.toBe(0);

    const outcome = prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome).toEqual([
      { agent: "claude", clone, branch: "issue-9/claude", action: "created", protocol: "overlay", hadOverlay: true }
    ]);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-9/claude");
    expect(git(clone, "rev-parse", "HEAD")).toBe(baseline);
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toContain("coordination protocol");
    expect(skipWorktree(clone)).toBe(true);
  });

  it("does not reset an existing issue branch that already has commits", () => {
    const { clone, baseline } = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    writeFileSync(join(clone, "join.json"), "{}\n");
    git(clone, "add", "join.json");
    git(clone, "commit", "-qm", "Claude: join");
    const kept = git(clone, "rev-parse", "HEAD");
    liftCloneAgentsProtocol(clone, { dryRun: false, log: () => undefined, changes: [] });
    git(clone, "checkout", "-q", "main");
    writeCloneAgentsProtocol({
      clone,
      installRoot: repoRoot,
      options: { dryRun: false, log: () => undefined, changes: [] }
    });

    const outcome = prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome[0]?.action).toBe("checked-out");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-9/claude");
    expect(git(clone, "rev-parse", "HEAD")).toBe(kept);
    expect(existsSync(join(clone, "join.json"))).toBe(true);
  });

  // A vendored clone records no `coord.installRoot` by design, so the template
  // the overlay came from cannot be located during preparation. The lift still
  // happens, and the bit still has to come back.
  it("restores the overlay and the bit when no install root can be resolved", () => {
    const { clone, baseline } = seedClone();
    expect(tryGit(clone, "config", "--local", "--get", "coord.installRoot").exitCode).not.toBe(0);

    const outcome = prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main"
    });

    expect(outcome[0]?.action).toBe("created");
    expect(outcome[0]?.protocol).toBe("overlay");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-9/claude");
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toContain("coordination protocol");
    expect(skipWorktree(clone)).toBe(true);
  });

  it("re-asserts the bit with no install root and no overlay to restore", () => {
    const { clone, baseline } = seedClone();
    liftCloneAgentsProtocol(clone, { dryRun: false, log: () => undefined, changes: [] });
    expect(skipWorktree(clone)).toBe(false);

    const outcome = prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main"
    });

    expect(outcome[0]?.protocol).toBe("bit-only");
    expect(skipWorktree(clone)).toBe(true);
  });

  it("re-sets the bit when the checkout fails", () => {
    const { clone } = seedClone();
    expect(() =>
      prepareAgentIssueBranches({
        agents: [{ id: "claude", root: clone }],
        issue: 9,
        branchTemplate: "issue-{issue}/{agent}",
        baselineSha: "f".repeat(40),
        baseBranch: "no-such-base",
        installRoot: repoRoot
      })
    ).toThrow(/Cannot resolve issue baseline/);
    // The lift ran before the failure; leaving the bit clear is what used to
    // make the next run refuse forever.
    expect(skipWorktree(clone)).toBe(true);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("heals a clone whose only dirt is an overlay left without the bit", () => {
    const { clone, baseline } = seedClone();
    const withOverlay = readFileSync(join(clone, "AGENTS.md"), "utf8");
    liftCloneAgentsProtocol(clone, { dryRun: false, log: () => undefined, changes: [] });
    writeFileSync(join(clone, "AGENTS.md"), withOverlay);
    expect(git(clone, "status", "--porcelain")).toContain("AGENTS.md");

    const outcome = prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome[0]?.action).toBe("created");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-9/claude");
    expect(skipWorktree(clone)).toBe(true);
  });

  it("still refuses when real work sits beside the lifted overlay", () => {
    const { clone, baseline } = seedClone();
    const withOverlay = readFileSync(join(clone, "AGENTS.md"), "utf8");
    liftCloneAgentsProtocol(clone, { dryRun: false, log: () => undefined, changes: [] });
    writeFileSync(join(clone, "AGENTS.md"), withOverlay);
    writeFileSync(join(clone, "dirty.txt"), "nope\n");

    expect(() =>
      prepareAgentIssueBranches({
        agents: [{ id: "claude", root: clone }],
        issue: 9,
        branchTemplate: "issue-{issue}/{agent}",
        baselineSha: baseline,
        baseBranch: "main",
        installRoot: repoRoot
      })
    ).toThrow(/uncommitted changes/);
  });

  // An install root can resolve to a directory whose template tree has been
  // moved or pruned. Restore runs in a `finally`, so a throw there would both
  // mask the original failure and leave the bit clear.
  it("recovers the overlay when the install root has no template tree", () => {
    const { clone, baseline } = seedClone();
    const emptyRoot = mkdtempSync(join(tmpdir(), "coord-no-template-"));
    roots.push(emptyRoot);

    const outcome = prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: emptyRoot
    });

    expect(outcome[0]?.protocol).toBe("overlay");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-9/claude");
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toContain("coordination protocol");
    expect(skipWorktree(clone)).toBe(true);
  });

  it("reports the overlay in the readiness result so a caller can assert on it", () => {
    const { clone, baseline } = seedClone();
    const outcome = prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    expect(outcome[0]?.hadOverlay).toBe(true);
    expect(outcome[0]?.protocol).toBe("overlay");
  });

  // The overlay exemption compares bytes exactly. Comparing loosely (trimming
  // whitespace, say) would let the lift's `git checkout HEAD -- AGENTS.md`
  // silently destroy a human edit that lives outside the managed block.
  it("still refuses a human edit outside the managed block", () => {
    const { clone, baseline } = seedClone();
    const withOverlay = readFileSync(join(clone, "AGENTS.md"), "utf8");
    git(clone, "update-index", "--no-skip-worktree", "--", "AGENTS.md");
    const humanEdit = `${withOverlay}   \n`;
    writeFileSync(join(clone, "AGENTS.md"), humanEdit);

    expect(() =>
      prepareAgentIssueBranches({
        agents: [{ id: "claude", root: clone }],
        issue: 9,
        branchTemplate: "issue-{issue}/{agent}",
        baselineSha: baseline,
        baseBranch: "main",
        installRoot: repoRoot
      })
    ).toThrow(/uncommitted changes/);
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe(humanEdit);
  });

  it("refuses a dirty clone", () => {
    const { clone, baseline } = seedClone();
    writeFileSync(join(clone, "dirty.txt"), "nope\n");
    expect(() =>
      prepareAgentIssueBranches({
        agents: [{ id: "claude", root: clone }],
        issue: 9,
        branchTemplate: "issue-{issue}/{agent}",
        baselineSha: baseline,
        baseBranch: "main",
        installRoot: repoRoot
      })
    ).toThrow(/uncommitted changes/);
    expect(existsSync(join(clone, "dirty.txt"))).toBe(true);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});

describe("makeAgentClonesBaseReady", () => {
  it("discards dirty completed-issue WIP and checks out origin/main", () => {
    const { clone, baseline } = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    const issueTip = git(clone, "rev-parse", "HEAD");
    const issueCount = git(clone, "rev-list", "--count", "issue-9/claude");
    writeFileSync(join(clone, "AGENTS.md"), `${readFileSync(join(clone, "AGENTS.md"), "utf8")}edit\n`);
    mkdirSync(join(clone, ".plans", "issue-9"), { recursive: true });
    writeFileSync(join(clone, ".plans", "issue-9", "plan.md"), "# plan\n");
    mkdirSync(join(clone, ".signals", "issue-9"), { recursive: true });
    writeFileSync(join(clone, ".signals", "issue-9", "x.json"), "{}\n");

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome[0]?.action).toBe("checked-out");
    expect(outcome[0]?.discardedPaths.length).toBeGreaterThan(0);
    expect(git(clone, "status", "--porcelain").trim()).toBe("");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(clone, "rev-parse", "origin/main"));
    expect(existsSync(join(clone, ".plans", "issue-9", "plan.md"))).toBe(false);
    expect(existsSync(join(clone, ".signals", "issue-9", "x.json"))).toBe(false);
    expect(git(clone, "rev-list", "--count", "issue-9/claude")).toBe(issueCount);
    expect(git(clone, "rev-parse", "issue-9/claude")).toBe(issueTip);
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toContain("coordination protocol");
    expect(skipWorktree(clone)).toBe(true);
  });

  it("checks out base for a clean issue-branch clone without reporting discards", () => {
    const { clone, baseline } = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    const issueTip = git(clone, "rev-parse", "HEAD");

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome[0]?.action).toBe("checked-out");
    expect(outcome[0]?.discardedPaths).toEqual([]);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(clone, "rev-parse", "issue-9/claude")).toBe(issueTip);
    expect(skipWorktree(clone)).toBe(true);
  });

  it("refuses wrong-branch dirt without mutating the clone", () => {
    const { clone } = seedClone();
    writeFileSync(join(clone, "dirty.txt"), "nope\n");
    const before = git(clone, "status", "--porcelain");

    const onMain = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });
    expect(onMain[0]?.action).toBe("refused");
    expect(onMain[0]?.reason).toMatch(/expected issue-9\/claude/);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(clone, "status", "--porcelain")).toBe(before);
    expect(existsSync(join(clone, "dirty.txt"))).toBe(true);

    git(clone, "checkout", "-qb", "issue-8/claude");
    const beforeOther = git(clone, "status", "--porcelain");
    const otherIssue = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });
    expect(otherIssue[0]?.action).toBe("refused");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-8/claude");
    expect(git(clone, "status", "--porcelain")).toBe(beforeOther);
  });

  it("skips missing and non-worktree paths", () => {
    const missing = join(tmpdir(), `coord-missing-${Date.now()}`);
    const notGit = mkdtempSync(join(tmpdir(), "coord-not-git-"));
    roots.push(notGit);

    const outcome = makeAgentClonesBaseReady({
      agents: [
        { id: "claude", root: missing },
        { id: "codex", root: notGit }
      ],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome.map((row) => row.action)).toEqual(["skipped-missing", "skipped-missing"]);
  });

  it("restores the protocol bit when base resolution fails", () => {
    const { clone, baseline } = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    git(clone, "remote", "remove", "origin");
    git(clone, "branch", "-D", "main");

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome[0]?.action).toBe("refused");
    expect(outcome[0]?.reason).toMatch(/Cannot resolve base branch/);
    expect(skipWorktree(clone)).toBe(true);
  });

  it("treats overlay-only AGENTS.md dirt as clean", () => {
    const { clone, baseline } = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    const withOverlay = readFileSync(join(clone, "AGENTS.md"), "utf8");
    liftCloneAgentsProtocol(clone, { dryRun: false, log: () => undefined, changes: [] });
    writeFileSync(join(clone, "AGENTS.md"), withOverlay);
    expect(git(clone, "status", "--porcelain")).toContain("AGENTS.md");

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome[0]?.action).toBe("checked-out");
    expect(outcome[0]?.discardedPaths).toEqual([]);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(skipWorktree(clone)).toBe(true);
  });
});
