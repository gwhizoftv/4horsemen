import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liftCloneAgentsProtocol, writeCloneAgentsProtocol } from "../src/agentsProtocol.js";
import { makeAgentClonesBaseReady, prepareAgentIssueBranches } from "../src/prepareAgentBranch.js";
import { git, repoRoot, tryGit } from "./support/workspaceFixture.js";

const baseBranchName = "main";

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
  /** Put the clone on the finished issue's branch, the way a run leaves it. */
  const onIssueBranch = (issue = 9): { clone: string; tip: string } => {
    const { clone, baseline } = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    return { clone, tip: git(clone, "rev-parse", "HEAD") };
  };

  const ready = (clone: string, issue = 9) =>
    makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

  it("discards leftover work on the finished issue branch and lands on the fetched base", () => {
    const { clone, tip } = onIssueBranch();
    writeFileSync(join(clone, "README.md"), "agent edit\n");
    git(clone, "add", "README.md");
    writeFileSync(join(clone, "scratch.txt"), "unstaged\n");
    mkdirSync(join(clone, ".plans", "issue-9"), { recursive: true });
    writeFileSync(join(clone, ".plans", "issue-9", "plan.md"), "# plan\n");
    const before = git(clone, "rev-list", "--count", "issue-9/claude");

    const [result] = ready(clone);

    expect(result?.action).toBe("checked-out");
    expect([...(result?.discardedPaths ?? [])].sort()).toEqual([".plans/", "README.md", "scratch.txt"]);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(baseBranchName);
    expect(result?.baseTip).toBe(git(clone, "rev-parse", `origin/${baseBranchName}`));
    expect(result?.baseSynced).toBe(true);
    expect(existsSync(join(clone, ".plans"))).toBe(false);
    expect(existsSync(join(clone, "scratch.txt"))).toBe(false);
    // The discard is worktree-only: the published branch and its history stand.
    expect(git(clone, "rev-list", "--count", "issue-9/claude")).toBe(before);
    expect(git(clone, "rev-parse", "issue-9/claude")).toBe(tip);
  });

  it("restores the AGENTS.md overlay and the skip-worktree bit after a discard", () => {
    const { clone } = onIssueBranch();
    writeFileSync(join(clone, "scratch.txt"), "wip\n");

    const [result] = ready(clone);

    expect(result?.protocol).toBe("overlay");
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toContain("coordination protocol");
    expect(skipWorktree(clone)).toBe(true);
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  it("checks a clean clone out on base without discarding anything", () => {
    const { clone } = onIssueBranch();

    const [result] = ready(clone);

    expect(result?.action).toBe("checked-out");
    expect(result?.discardedPaths).toEqual([]);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(baseBranchName);
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(clone, "rev-parse", `origin/${baseBranchName}`));
    expect(tryGit(clone, "show-ref", "--verify", "--quiet", "refs/heads/issue-9/claude").exitCode).toBe(0);
  });

  it("refuses dirt on a branch that is not the finished issue's and changes nothing", () => {
    const { clone } = seedClone();
    writeFileSync(join(clone, "owner.txt"), "owner work\n");
    const status = git(clone, "status", "--porcelain");

    const [result] = ready(clone);

    expect(result?.action).toBe("refused");
    expect(result?.reason).toMatch(/uncommitted changes on .*, not issue-9\/claude/);
    expect(result?.discardedPaths).toEqual([]);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(baseBranchName);
    expect(git(clone, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(clone, "owner.txt"), "utf8")).toBe("owner work\n");
  });

  it("refuses dirt on another issue's branch", () => {
    const { clone } = onIssueBranch(8);
    writeFileSync(join(clone, "scratch.txt"), "issue 8 wip\n");

    const [result] = ready(clone, 9);

    expect(result?.action).toBe("refused");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-8/claude");
    expect(existsSync(join(clone, "scratch.txt"))).toBe(true);
  });

  it("leaves every clone untouched when one of them is dirty on the wrong branch", () => {
    const eligible = onIssueBranch();
    const ambiguous = seedClone();
    writeFileSync(join(eligible.clone, "scratch.txt"), "eligible wip\n");
    writeFileSync(join(ambiguous.clone, "owner.txt"), "owner work\n");

    const results = makeAgentClonesBaseReady({
      agents: [
        { id: "claude", root: eligible.clone },
        { id: "codex", root: ambiguous.clone }
      ],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(results.map((result) => result.action)).toEqual(["refused", "refused"]);
    expect(results[0]?.reason).toMatch(/another agent clone has unauthorized changes/);
    expect(results[0]?.reason).toContain(ambiguous.clone);
    expect(existsSync(join(eligible.clone, "scratch.txt"))).toBe(true);
    expect(git(eligible.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-9/claude");
  });

  it("skips a missing path and a directory that is not a worktree", () => {
    const plain = mkdtempSync(join(tmpdir(), "coord-not-a-repo-"));
    roots.push(plain);
    const absent = join(plain, "gone");

    const results = makeAgentClonesBaseReady({
      agents: [
        { id: "codex", root: absent },
        { id: "cursor", root: plain }
      ],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(results.map((result) => result.action)).toEqual(["skipped-missing", "skipped-missing"]);
    expect(results.every((result) => result.discardedPaths.length === 0)).toBe(true);
  });

  it("treats an overlay-only AGENTS.md delta as clean rather than as agent work", () => {
    const { clone } = onIssueBranch();
    // The state a run leaves when it clears the bit and fails to restore it.
    git(clone, "update-index", "--no-skip-worktree", "--", "AGENTS.md");
    expect(git(clone, "status", "--porcelain")).not.toBe("");

    const [result] = ready(clone);

    expect(result?.action).toBe("checked-out");
    expect(result?.discardedPaths).toEqual([]);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(baseBranchName);
    expect(skipWorktree(clone)).toBe(true);
  });

  it("keeps a local base branch that origin does not contain instead of resetting it", () => {
    // The commit lands on the base branch before the run starts, so the clone is
    // on `issue-9/claude` with a local base that origin has never seen.
    const { clone, baseline } = seedClone();
    writeFileSync(join(clone, "local-only.txt"), "unpushed\n");
    git(clone, "add", "local-only.txt");
    git(clone, "commit", "-qm", "unpushed local base commit");
    const localBase = git(clone, "rev-parse", baseBranchName);
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: baseBranchName,
      installRoot: repoRoot
    });
    writeFileSync(join(clone, "scratch.txt"), "wip\n");

    const [result] = ready(clone);

    expect(result?.action).toBe("checked-out");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(baseBranchName);
    // Only issue-9 work was authorized for discard; the unpushed base commit stands.
    expect(git(clone, "rev-parse", baseBranchName)).toBe(localBase);
    expect(existsSync(join(clone, "local-only.txt"))).toBe(true);
    expect(existsSync(join(clone, "scratch.txt"))).toBe(false);
  });

  it("reports the local base when the origin base cannot be resolved", () => {
    const { clone } = onIssueBranch();
    git(clone, "remote", "remove", "origin");
    git(clone, "update-ref", "-d", `refs/remotes/origin/${baseBranchName}`);
    writeFileSync(join(clone, "scratch.txt"), "wip\n");

    const [result] = ready(clone);

    expect(result?.action).toBe("checked-out");
    expect(result?.baseSynced).toBe(false);
    expect(result?.baseTip).toBe(git(clone, "rev-parse", baseBranchName));
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(baseBranchName);
    expect(git(clone, "status", "--porcelain")).toBe("");
  });
});
