import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liftCloneAgentsProtocol, writeCloneAgentsProtocol } from "../src/agentsProtocol.js";
import { prepareAgentIssueBranches } from "../src/prepareAgentBranch.js";
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
      { agent: "claude", clone, branch: "issue-9/claude", action: "created", protocol: "overlay" }
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
