import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liftCloneAgentsProtocol, writeCloneAgentsProtocol } from "../src/agentsProtocol.js";
import {
  AgentCloneReadinessRefusal,
  makeAgentClonesBaseReady,
  makeManualClonesBaseReady,
  prepareAgentIssueBranches
} from "../src/prepareAgentBranch.js";
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
  it("rejoins its exact issue branch without touching local commits, index, worktree or untracked work", () => {
    const { clone, baseline } = seedClone();
    const input = { agents: [{ id: "claude", root: clone }], issue: 9,
      branchTemplate: "issue-{issue}/{agent}", baselineSha: baseline, baseBranch: "main", installRoot: repoRoot };
    prepareAgentIssueBranches(input);
    writeFileSync(join(clone, "work.txt"), "local commit\n");
    git(clone, "add", "work.txt");
    git(clone, "commit", "-qm", "Claude: local work");
    const tip = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(clone, "work.txt"), "staged work\n");
    git(clone, "add", "work.txt");
    writeFileSync(join(clone, "work.txt"), "unstaged work\n");
    mkdirSync(join(clone, ".plans", "issue-9"), { recursive: true });
    const plan = join(clone, ".plans", "issue-9", "plan.md");
    writeFileSync(plan, "unfinished plan\n");
    const agents = `${readFileSync(join(clone, "AGENTS.md"), "utf8")}\nHuman note\n`;
    writeFileSync(join(clone, "AGENTS.md"), agents);

    expect(prepareAgentIssueBranches(input)[0]?.action).toBe("already-on-branch");
    expect(git(clone, "rev-parse", "HEAD")).toBe(tip);
    expect(git(clone, "show", ":work.txt")).toBe("staged work");
    expect(readFileSync(join(clone, "work.txt"), "utf8")).toBe("unstaged work\n");
    expect(readFileSync(plan, "utf8")).toBe("unfinished plan\n");
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe(agents);
    expect(skipWorktree(clone)).toBe(true);
  });

  it("refuses a mixed batch before touching eligible same-branch WIP or another clone", () => {
    const ready = seedClone();
    const other = seedClone();
    const input = { agents: [{ id: "claude", root: ready.clone }], issue: 9,
      branchTemplate: "issue-{issue}/{agent}", baselineSha: ready.baseline, baseBranch: "main", installRoot: repoRoot };
    prepareAgentIssueBranches(input);
    for (const clone of [ready.clone, other.clone]) writeFileSync(join(clone, "dirty.txt"), "keep\n");
    const before = [ready.clone, other.clone].map((clone) => ({
      head: git(clone, "rev-parse", "HEAD"), agents: readFileSync(join(clone, "AGENTS.md"), "utf8")
    }));
    expect(() => prepareAgentIssueBranches({ ...input, agents: [...input.agents, { id: "codex", root: other.clone }] }))
      .toThrow(`uncommitted changes in ${other.clone}`);
    [ready.clone, other.clone].forEach((clone, index) => {
      expect(git(clone, "rev-parse", "HEAD")).toBe(before[index]!.head);
      expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe(before[index]!.agents);
      expect(readFileSync(join(clone, "dirty.txt"), "utf8")).toBe("keep\n");
      expect(skipWorktree(clone)).toBe(true);
    });
  });

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

  it.each(["main", "issue-10/claude", "detached"])("refuses a dirty clone on %s", (branch) => {
    const { clone, baseline } = seedClone();
    if (branch === "detached") git(clone, "checkout", "-q", "--detach");
    else if (branch !== "main") git(clone, "checkout", "-q", "-b", branch);
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
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch === "detached" ? "HEAD" : branch);
  });
});

describe("makeAgentClonesBaseReady", () => {
  it("discards tracked and untracked WIP only on the completed issue branch", () => {
    const { clone, baseline } = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    writeFileSync(join(clone, "tracked.txt"), "published\n");
    git(clone, "add", "tracked.txt");
    git(clone, "commit", "-qm", "Claude: published work");
    const issueTip = git(clone, "rev-parse", "HEAD");
    const issueCount = git(clone, "rev-list", "--count", "issue-9/claude");
    writeFileSync(join(clone, "tracked.txt"), "unfinished\n");
    git(clone, "add", "tracked.txt");
    mkdirSync(join(clone, ".plans", "issue-9"), { recursive: true });
    writeFileSync(join(clone, ".plans", "issue-9", "plan.md"), "unfinished plan\n");

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome[0]?.action).toBe("checked-out");
    expect(outcome[0]?.discardedPaths).toEqual(expect.arrayContaining(["tracked.txt", ".plans/"]));
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(baseline);
    expect(outcome[0]?.baseTip).toBe(baseline);
    expect(outcome[0]?.baseSynced).toBe(true);
    expect(existsSync(join(clone, ".plans"))).toBe(false);
    expect(git(clone, "rev-parse", "issue-9/claude")).toBe(issueTip);
    expect(git(clone, "rev-list", "--count", "issue-9/claude")).toBe(issueCount);
    expect(git(clone, "show", "issue-9/claude:tracked.txt")).toBe("published");
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toContain("coordination protocol");
    expect(skipWorktree(clone)).toBe(true);
  });

  it("checks out a clean issue clone without deleting its issue branch", () => {
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

  it("refreshes origin base before checking out a clean issue clone", () => {
    const { clone, baseline } = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    const publisher = `${clone}-publisher`;
    mkdirSync(publisher);
    git(publisher, "clone", "-q", git(clone, "remote", "get-url", "origin"), publisher);
    git(publisher, "config", "user.name", "Fixture");
    git(publisher, "config", "user.email", "fixture@example.com");
    writeFileSync(join(publisher, "remote.txt"), "new base\n");
    git(publisher, "add", "remote.txt");
    git(publisher, "commit", "-qm", "advance base");
    const advanced = git(publisher, "rev-parse", "HEAD");
    git(publisher, "push", "-q", "origin", "main");

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome[0]?.action).toBe("checked-out");
    expect(outcome[0]?.baseSynced).toBe(true);
    expect(outcome[0]?.baseTip).toBe(advanced);
    expect(git(clone, "rev-parse", "HEAD")).toBe(advanced);
    expect(git(clone, "rev-parse", "origin/main")).toBe(advanced);
  });

  it("refuses dirty work on another issue branch without changing it", () => {
    const { clone, baseline } = seedClone();
    liftCloneAgentsProtocol(clone, { dryRun: false, log: () => undefined, changes: [] });
    git(clone, "checkout", "-qb", "issue-8/claude", baseline);
    writeCloneAgentsProtocol({
      clone,
      installRoot: repoRoot,
      options: { dryRun: false, log: () => undefined, changes: [] }
    });
    writeFileSync(join(clone, "dirty.txt"), "keep me\n");
    const before = git(clone, "status", "--porcelain");

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome[0]?.action).toBe("refused");
    expect(outcome[0]?.reason).toContain("issue-8/claude");
    expect(outcome[0]?.reason).toContain("coord reset-clones --force");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-8/claude");
    expect(git(clone, "status", "--porcelain")).toBe(before);
    expect(readFileSync(join(clone, "dirty.txt"), "utf8")).toBe("keep me\n");
  });

  it("supports an all-clone preflight for wipe without partial cleanup", () => {
    const first = seedClone();
    const second = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: first.clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: first.baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    writeFileSync(join(first.clone, "eligible.txt"), "unfinished\n");
    writeFileSync(join(second.clone, "ambiguous.txt"), "keep\n");

    expect(() =>
      makeAgentClonesBaseReady({
        agents: [
          { id: "claude", root: first.clone },
          { id: "codex", root: second.clone }
        ],
        issue: 9,
        branchTemplate: "issue-{issue}/{agent}",
        baseBranch: "main",
        installRoot: repoRoot,
        batchPolicy: "refuse-all"
      })
    ).toThrow(AgentCloneReadinessRefusal);
    expect(git(first.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-9/claude");
    expect(readFileSync(join(first.clone, "eligible.txt"), "utf8")).toBe("unfinished\n");
    expect(git(second.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(second.clone, "ambiguous.txt"), "utf8")).toBe("keep\n");
  });

  it("resets local base to origin when it contains commits absent from origin", () => {
    const { clone, baseline } = seedClone();
    liftCloneAgentsProtocol(clone, { dryRun: false, log: () => undefined, changes: [] });
    git(clone, "checkout", "-q", "-B", "main", baseline);
    writeCloneAgentsProtocol({
      clone,
      installRoot: repoRoot,
      options: { dryRun: false, log: () => undefined, changes: [] }
    });
    writeFileSync(join(clone, "owner.txt"), "local base commit\n");
    git(clone, "add", "owner.txt");
    git(clone, "commit", "-qm", "owner local base work");
    const originMain = git(clone, "rev-parse", "origin/main");
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    writeFileSync(join(clone, "unfinished.txt"), "discard after base is reset\n");
    const logs: string[] = [];

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot,
      log: (message) => logs.push(message)
    });

    expect(outcome[0]?.action).toBe("checked-out");
    expect(outcome[0]?.baseTip).toBe(originMain);
    expect(outcome[0]?.baseSynced).toBe(true);
    expect(outcome[0]?.discardedPaths).toEqual(["unfinished.txt"]);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(originMain);
    expect(git(clone, "rev-parse", "main")).toBe(originMain);
    expect(existsSync(join(clone, "unfinished.txt"))).toBe(false);
    expect(existsSync(join(clone, "owner.txt"))).toBe(false);
    expect(logs.join("")).toContain("resetting diverged local main");
    expect(skipWorktree(clone)).toBe(true);
  });

  it("resets every wipe clone's diverged local base before discard", () => {
    const first = seedClone();
    const second = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: first.clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: first.baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    writeFileSync(join(first.clone, "eligible.txt"), "discard after base reset\n");

    liftCloneAgentsProtocol(second.clone, { dryRun: false, log: () => undefined, changes: [] });
    git(second.clone, "checkout", "-q", "-B", "main", second.baseline);
    writeCloneAgentsProtocol({
      clone: second.clone,
      installRoot: repoRoot,
      options: { dryRun: false, log: () => undefined, changes: [] }
    });
    writeFileSync(join(second.clone, "owner.txt"), "local base commit\n");
    git(second.clone, "add", "owner.txt");
    git(second.clone, "commit", "-qm", "owner local base work");
    const originMain = git(second.clone, "rev-parse", "origin/main");
    prepareAgentIssueBranches({
      agents: [{ id: "codex", root: second.clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: second.baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });

    const outcome = makeAgentClonesBaseReady({
      agents: [
        { id: "claude", root: first.clone },
        { id: "codex", root: second.clone }
      ],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot,
      batchPolicy: "refuse-all"
    });

    expect(outcome.map(({ action }) => action)).toEqual(["checked-out", "checked-out"]);
    expect(existsSync(join(first.clone, "eligible.txt"))).toBe(false);
    expect(git(first.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(second.clone, "rev-parse", "main")).toBe(originMain);
    expect(git(second.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(existsSync(join(second.clone, "owner.txt"))).toBe(false);
  });

  it("skips missing and non-worktree clone roots", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-base-ready-missing-"));
    roots.push(workspace);
    const notGit = join(workspace, "not-git");
    mkdirSync(notGit);

    const outcome = makeAgentClonesBaseReady({
      agents: [
        { id: "claude", root: join(workspace, "missing") },
        { id: "codex", root: notGit }
      ],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot
    });

    expect(outcome.map(({ action }) => action)).toEqual(["skipped-missing", "skipped-missing"]);
  });

  it("audits a completed discard when a later base checkout fails", () => {
    const { clone, baseline } = seedClone();
    prepareAgentIssueBranches({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baselineSha: baseline,
      baseBranch: "main",
      installRoot: repoRoot
    });
    writeFileSync(
      join(clone, ".git", "hooks", "post-checkout"),
      "#!/bin/sh\necho 'blocked checkout for audit test' >&2\nexit 1\n",
      { mode: 0o700 }
    );
    writeFileSync(join(clone, "unfinished.txt"), "discard me\n");
    const logs: string[] = [];

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot,
      log: (message) => logs.push(message)
    });

    expect(outcome[0]?.action).toBe("refused");
    expect(outcome[0]?.discardedPaths).toEqual(["unfinished.txt"]);
    expect(outcome[0]?.reason).toContain("blocked checkout for audit test");
    expect(existsSync(join(clone, "unfinished.txt"))).toBe(false);
    expect(logs.join("")).toContain("discarded 1 path(s)");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(skipWorktree(clone)).toBe(true);
  });

  it("uses and reports the local base when origin is unavailable", () => {
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
    writeFileSync(join(clone, "unfinished.txt"), "discard offline\n");
    const logs: string[] = [];

    const outcome = makeAgentClonesBaseReady({
      agents: [{ id: "claude", root: clone }],
      issue: 9,
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      installRoot: repoRoot,
      log: (message) => logs.push(message)
    });

    expect(outcome[0]?.action).toBe("checked-out");
    expect(outcome[0]?.baseSynced).toBe(false);
    expect(outcome[0]?.baseTip).toBe(git(clone, "rev-parse", "main"));
    expect(outcome[0]?.discardedPaths).toEqual(["unfinished.txt"]);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(logs.join("")).toContain("using fallback main");
    expect(skipWorktree(clone)).toBe(true);
  });
});

describe("manual clone readiness", () => {
  it.each([false, true])("returns a merged or published scratch branch to fresh base (published=%s)", async (published) => {
    const { clone, baseline } = seedClone();
    git(clone, "checkout", "-qb", "claude/manual");
    if (published) {
      writeFileSync(join(clone, "work.txt"), "published\n");
      git(clone, "add", "work.txt"); git(clone, "commit", "-qm", "manual work");
      git(clone, "push", "-qu", "origin", "claude/manual");
    }
    const scratchTip = git(clone, "rev-parse", "HEAD");
    let closed = false;
    const [result] = await makeManualClonesBaseReady({ agents: [{ id: "claude", root: clone }], baseBranch: "main",
      beforeCheckout: async () => { closed = true; } });
    expect(closed).toBe(true);
    expect(result).toMatchObject({ action: "checked-out", baseTip: baseline, baseSynced: true, discardedPaths: [], protocol: "overlay" });
    expect(git(clone, "branch", "--show-current")).toBe("main");
    expect(git(clone, "rev-parse", "claude/manual")).toBe(scratchTip);
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toContain("# product v2");
    expect(skipWorktree(clone)).toBe(true);
  });

  it.each(["untracked", "tracked", "hidden", "unpublished", "base-ahead", "stale-upstream", "offline"])(
    "refuses %s before closing UI or changing any clone", async (kind) => {
      const { clone } = seedClone();
      if (kind !== "base-ahead") git(clone, "checkout", "-qb", "claude/manual");
      if (kind === "hidden") writeFileSync(join(clone, "AGENTS.md"), readFileSync(join(clone, "AGENTS.md"), "utf8") + "owner note\n");
      else if (kind !== "offline") {
        writeFileSync(join(clone, "work.txt"), "keep\n");
        if (kind !== "untracked") {
          git(clone, "add", "work.txt"); git(clone, "commit", "-qm", "manual work");
          if (kind === "tracked") writeFileSync(join(clone, "work.txt"), "unsaved\n");
          if (kind === "stale-upstream") {
            git(clone, "push", "-qu", "origin", "claude/manual");
            const origin = git(clone, "remote", "get-url", "origin");
            git(origin, "update-ref", "-d", "refs/heads/claude/manual");
          }
        }
      }
      if (kind === "offline") git(clone, "remote", "set-url", "origin", join(clone, "missing-origin"));
      const ready = seedClone();
      const tip = git(clone, "rev-parse", "HEAD"), head = git(clone, "branch", "--show-current");
      const agents = readFileSync(join(clone, "AGENTS.md"), "utf8");
      let closed = false;
      const results = await makeManualClonesBaseReady({ agents: [{ id: "claude", root: ready.clone }, { id: "codex", root: clone }],
        baseBranch: "main", beforeCheckout: async () => { closed = true; } });
      expect(results.every((result) => result.action === "refused" && result.discardedPaths.length === 0)).toBe(true);
      expect(closed).toBe(false);
      expect(git(clone, "rev-parse", "HEAD")).toBe(tip);
      expect(git(clone, "branch", "--show-current")).toBe(head);
      expect(git(ready.clone, "rev-parse", "HEAD")).toBe(ready.earlier);
      expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe(agents);
      expect(skipWorktree(clone)).toBe(true);
      if (existsSync(join(clone, "work.txt"))) expect(readFileSync(join(clone, "work.txt"), "utf8")).toBe(kind === "tracked" ? "unsaved\n" : "keep\n");
    }
  );

  it("leaves branch, worktree and protocol unchanged in dry run and refuses writes during teardown", async () => {
    const { clone, earlier } = seedClone();
    git(clone, "checkout", "-qb", "claude/manual");
    const input = { agents: [{ id: "claude", root: clone }], baseBranch: "main" };
    const agents = readFileSync(join(clone, "AGENTS.md"), "utf8");
    expect((await makeManualClonesBaseReady({ ...input, dryRun: true }))[0]?.action).toBe("checked-out");
    expect(git(clone, "branch", "--show-current")).toBe("claude/manual");
    expect(git(clone, "rev-parse", "HEAD")).toBe(earlier);
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe(agents);
    const [result] = await makeManualClonesBaseReady({ ...input, beforeCheckout: async () => {
      writeFileSync(join(clone, "new-work"), "keep");
    } });
    expect(result?.action).toBe("refused");
    expect(git(clone, "branch", "--show-current")).toBe("claude/manual");
    expect(readFileSync(join(clone, "new-work"), "utf8")).toBe("keep");
  });

  it.each([false, true])("names blocking paths and distinguishes untracked leftovers (tracked=%s)", (tracked) => {
    const { clone, baseline } = seedClone();
    writeFileSync(join(clone, "work.txt"), "keep");
    if (tracked) git(clone, "add", "work.txt");
    const run = () => prepareAgentIssueBranches({ agents: [{ id: "claude", root: clone }], issue: 7,
      baseBranch: "main", baselineSha: baseline, branchTemplate: "issue-{issue}/{agent}" });
    expect(run).toThrow("work.txt");
    expect(run).toThrow(tracked ? "Commit/stash" : "coord reset-clones 7 --force");
  });
});
