import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCloneHooks, readHookManifest } from "../src/hookSync.js";
import { install } from "../src/install.js";
import {
  declaredChecks,
  ensureBuilt,
  failingPrecommit,
  git,
  makeProduct,
  passingVerify,
  repoRoot,
  silence,
  tryGit,
  writeDeclaration,
  type ProductFixture
} from "./support/workspaceFixture.js";

const fixtures: ProductFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

type Installed = { fixture: ProductFixture; clone: string; configPath: string };

/** `verify: null` installs a workspace that declares no verification at all. */
const installed = (verify: unknown = passingVerify, kind: "go" | "plain" = "go"): Installed => {
  ensureBuilt();
  const fixture = makeProduct(kind);
  fixtures.push(fixture);
  const declaration: Record<string, unknown> = { checks: declaredChecks };
  if (verify !== null) declaration.verify = verify;
  const result = install({
    installRoot: repoRoot,
    productRoot: fixture.productRoot,
    coordRoot: fixture.coordRoot,
    agents: ["claude"],
    profile: "solo",
    declarePath: writeDeclaration(fixture.workspaceRoot, declaration),
    writeProduct: false,
    vendor: false,
    bootstrap: false,
    dryRun: false,
    log: silence().log
  });
  return { fixture, clone: result.clones[0] as string, configPath: result.configPath };
};

/** Put the clone on a branch the agent owns, with something staged to commit. */
const stageWork = (clone: string, branch = "issue-1/claude", file = "cmd/feature.go"): void => {
  git(clone, "checkout", "-q", "-b", branch);
  writeFileSync(join(clone, file), "package main\n");
  git(clone, "add", "-A");
};

describe("agent-clone hook wiring", () => {
  it("installs shims that carry no policy and exec the canonical bodies", () => {
    const { clone } = installed();
    const shim = readFileSync(join(clone, ".git", "hooks", "pre-commit"), "utf8");
    expect(shim).toContain('exec "$body"');
    expect(shim).toContain("coord.installRoot");
    expect(shim).not.toContain("package.json");

    const manifest = readHookManifest(clone);
    expect(manifest?.mode).toBe("shim");
    expect(Object.keys(manifest?.files ?? {}).sort()).toEqual([
      "commit-msg",
      "post-commit",
      "post-merge",
      "pre-commit",
      "pre-push"
    ]);
  });

  it("blocks commit and push when the install root is unset", () => {
    const { clone } = installed();
    stageWork(clone);
    git(clone, "config", "--local", "--unset", "coord.installRoot");

    const committed = tryGit(clone, "commit", "-m", "Claude: work");
    expect(committed.exitCode).not.toBe(0);
    expect(committed.stderr).toContain("HOOK BLOCKED");
    expect(committed.stderr).toContain("coord install");

    git(clone, "config", "--local", "coord.installRoot", repoRoot);
    git(clone, "commit", "-qm", "Claude: work");
    git(clone, "config", "--local", "--unset", "coord.installRoot");

    const pushed = tryGit(clone, "push", "-q", "origin", "issue-1/claude");
    expect(pushed.exitCode).not.toBe(0);
    expect(pushed.stderr).toContain("HOOK BLOCKED");
  });

  it("blocks when the install root points at a directory that no longer exists", () => {
    const { clone, fixture } = installed();
    stageWork(clone);
    git(clone, "config", "--local", "coord.installRoot", join(fixture.workspaceRoot, "moved-away"));

    const committed = tryGit(clone, "commit", "-m", "Claude: work");
    expect(committed.exitCode).not.toBe(0);
    expect(committed.stderr).toContain("has no executable githooks/pre-commit");
  });

  it("enforces branch ownership and the commit-message prefix", () => {
    const { clone } = installed();
    stageWork(clone, "issue-1/codex");
    const foreign = tryGit(clone, "commit", "-m", "Claude: work");
    expect(foreign.exitCode).not.toBe(0);
    expect(foreign.stderr).toContain("belongs to agent 'codex'");

    git(clone, "checkout", "-q", "-b", "issue-1/claude");
    const unprefixed = tryGit(clone, "commit", "-m", "work without a label");
    expect(unprefixed.exitCode).not.toBe(0);
    expect(unprefixed.stderr).toContain("must start with 'Claude: '");

    expect(tryGit(clone, "commit", "-m", "Claude: work").exitCode).toBe(0);
  });

  it("passes through in a clone with no agent identity, rather than blocking it", () => {
    // The placement rule already keeps hooks out of human clones. This is the
    // defence in depth for a tree where they end up shared anyway: coordination
    // must never turn someone else's working repository into a blocked one.
    const { clone } = installed();
    stageWork(clone);
    git(clone, "config", "--local", "--unset", "consensus.agentId");

    const committed = tryGit(clone, "commit", "-m", "no label at all");
    expect(committed.exitCode).toBe(0);
  });

  it("still fails closed when an agent clone's identity is malformed", () => {
    const { clone } = installed();
    stageWork(clone);
    git(clone, "config", "--local", "consensus.agentId", "Not A Valid Id");

    const committed = tryGit(clone, "commit", "-m", "Claude: work");
    expect(committed.exitCode).not.toBe(0);
    expect(committed.stderr).toContain("is not a valid agent id");
  });

  it("unsets a legacy core.hooksPath so the installed hooks are the ones git runs", () => {
    const { clone, fixture } = installed();
    git(clone, "config", "--local", "core.hooksPath", "githooks");
    install({
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      coordRoot: fixture.coordRoot,
      agents: ["claude"],
      profile: "solo",
      declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }),
      writeProduct: false,
      vendor: false,
      bootstrap: false,
      dryRun: false,
      log: silence().log
    });
    expect(tryGit(clone, "config", "--local", "--get", "core.hooksPath").exitCode).not.toBe(0);
  });
});

describe("declared verification in the hooks", () => {
  it("blocks a commit when a declared precommit command fails, in a non-Node product", () => {
    const { clone } = installed(failingPrecommit);
    expect(existsSync(join(clone, "go.mod"))).toBe(true);
    stageWork(clone);

    const committed = tryGit(clone, "commit", "-m", "Claude: work");
    expect(committed.exitCode).not.toBe(0);
    expect(`${committed.stdout}${committed.stderr}`).toContain("must-fail");
  });

  it("blocks a commit when the project declared no verification at all", () => {
    const { clone } = installed(null, "plain");
    git(clone, "checkout", "-q", "-b", "issue-1/claude");
    writeFileSync(join(clone, "feature.txt"), "work\n");
    git(clone, "add", "-A");

    const committed = tryGit(clone, "commit", "-m", "Claude: work");
    expect(committed.exitCode).not.toBe(0);
    expect(`${committed.stdout}${committed.stderr}`).toContain("declares no `verify`");
  });

  it("allows a commit when the project declared verification empty on purpose", () => {
    const { clone } = installed({ precommit: [], prepush: [] }, "plain");
    git(clone, "checkout", "-q", "-b", "issue-1/claude");
    writeFileSync(join(clone, "feature.txt"), "work\n");
    git(clone, "add", "-A");

    expect(tryGit(clone, "commit", "-m", "Claude: work").exitCode).toBe(0);
  });

  it("skips declared checks for a commit that only moves coordination evidence", () => {
    // The declared command is one that always fails, so a commit that succeeds
    // proves the evidence-only path really did skip it. Evidence commits change
    // no product code, so the project's own checks have nothing to say.
    const { clone } = installed(failingPrecommit);
    git(clone, "checkout", "-q", "-b", "issue-1/claude");
    const plans = join(clone, ".plans", "issue-1");
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, "plan.md"), "# plan\n");
    git(clone, "add", "-A");

    expect(tryGit(clone, "commit", "-m", "Claude: publish plan").exitCode).toBe(0);
  });
});

describe("vendored delivery", () => {
  const installVendored = (fixture: ProductFixture) =>
    install({
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      coordRoot: fixture.coordRoot,
      agents: ["claude"],
      profile: "solo",
      declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }, "vendor"),
      writeProduct: false,
      vendor: true,
      bootstrap: false,
      dryRun: false,
      log: silence().log
    });

  it("copies the bodies in and leaves no install root for post-merge to prefer", () => {
    const { fixture, clone } = installed();
    installVendored(fixture);

    const manifest = readHookManifest(clone);
    expect(manifest?.mode).toBe("vendor");
    expect(Object.keys(manifest?.files ?? {})).toContain("lib/identity.sh");
    expect(readFileSync(join(clone, ".git", "hooks", "pre-commit"), "utf8")).toContain("coord_verify precommit");
    expect(tryGit(clone, "config", "--local", "--get", "coord.installRoot").exitCode).not.toBe(0);
  });

  it("enforces the same gates from the copied bodies", () => {
    const { fixture, clone } = installed();
    installVendored(fixture);
    stageWork(clone);

    expect(tryGit(clone, "commit", "-m", "no label").exitCode).not.toBe(0);
    expect(tryGit(clone, "commit", "-m", "Claude: work").exitCode).toBe(0);
  });
});

describe("hook drift", () => {
  it("reports an edited hook rather than silently repairing it", () => {
    const { clone } = installed();
    writeFileSync(join(clone, ".git", "hooks", "pre-commit"), "#!/usr/bin/env bash\nexit 0\n");
    expect(
      inspectCloneHooks({ clone, installRoot: repoRoot, installCommit: readHookManifest(clone)?.sourceCommit ?? "" })
    ).toEqual({ kind: "modified", files: ["pre-commit"] });
  });

  it("reports a vendored copy that has fallen behind the install", () => {
    const { clone } = installed();
    const manifest = readHookManifest(clone);
    writeFileSync(
      join(clone, ".git", "hooks", "coord-hooks.json"),
      JSON.stringify({ ...manifest, mode: "vendor" }, null, 2)
    );
    expect(inspectCloneHooks({ clone, installRoot: repoRoot, installCommit: "f".repeat(40) })).toMatchObject({
      kind: "stale-vendor"
    });
  });

  it("reports hooks shadowed by core.hooksPath", () => {
    const { clone } = installed();
    git(clone, "config", "--local", "core.hooksPath", "elsewhere");
    expect(
      inspectCloneHooks({ clone, installRoot: repoRoot, installCommit: readHookManifest(clone)?.sourceCommit ?? "" })
    ).toEqual({ kind: "shadowed", hooksPath: "elsewhere" });
  });
});
