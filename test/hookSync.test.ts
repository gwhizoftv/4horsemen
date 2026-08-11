import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCloneHooks, readHookManifest, removeCloneHooks, type HookManifest } from "../src/hookSync.js";
import { install, uninstall } from "../src/install.js";
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

/** The manifest, asserted readable — every test here installs one first. */
const manifestOf = (clone: string): HookManifest => {
  const read = readHookManifest(clone);
  if (read.kind !== "ok") throw new Error(`expected a valid manifest, got ${read.kind}`);
  return read.manifest;
};

/** Re-run the installer against an already-installed fixture. */
const installAgain = (fixture: ProductFixture): void => {
  install({
    installRoot: repoRoot,
    productRoot: fixture.productRoot,
    coordRoot: fixture.coordRoot,
    agents: ["claude"],
    profile: "solo",
    declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }, "again"),
    writeProduct: false,
    vendor: false,
    bootstrap: false,
    dryRun: false,
    log: silence().log
  });
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

    const manifest = manifestOf(clone);
    expect(manifest.mode).toBe("shim");
    expect(Object.keys(manifest.files).sort()).toEqual([
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

  it("blocks when agentId is unset but the coordination wiring remains", () => {
    // The wiring is what makes this an agent clone. Keying the decision on the
    // id alone let a single `git config --unset` skip branch ownership, the
    // commit prefix, and the declared verify in a fully installed clone.
    const { clone } = installed();
    stageWork(clone);
    git(clone, "config", "--local", "--unset", "consensus.agentId");

    const committed = tryGit(clone, "commit", "-m", "ungated");
    expect(committed.exitCode).not.toBe(0);
    expect(committed.stderr).toContain("coordination install wiring");

    const pushed = tryGit(clone, "push", "origin", "issue-1/claude");
    expect(pushed.exitCode).not.toBe(0);
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

    const manifest = manifestOf(clone);
    expect(manifest.mode).toBe("vendor");
    expect(Object.keys(manifest.files)).toContain("lib/identity.sh");
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
      inspectCloneHooks({ clone, installRoot: repoRoot, installCommit: manifestOf(clone).sourceCommit })
    ).toEqual({ kind: "modified", files: ["pre-commit"] });
  });

  it("reports hooks shadowed by core.hooksPath", () => {
    const { clone } = installed();
    git(clone, "config", "--local", "core.hooksPath", "elsewhere");
    expect(
      inspectCloneHooks({ clone, installRoot: repoRoot, installCommit: manifestOf(clone).sourceCommit })
    ).toEqual({ kind: "shadowed", hooksPath: "elsewhere" });
  });
});

describe("hook attestation", () => {
  it("restores an execute bit that was lost, and reports it until then", () => {
    // Git skips a non-executable hook and says nothing, so bytes alone are not
    // health: a reinstall used to classify this "unchanged" and doctor "ok".
    const { clone, fixture } = installed();
    const hook = join(clone, ".git", "hooks", "pre-commit");
    chmodSync(hook, 0o644);

    expect(
      inspectCloneHooks({ clone, installRoot: repoRoot, installCommit: manifestOf(clone).sourceCommit })
    ).toEqual({ kind: "not-executable", files: ["pre-commit"] });

    installAgain(fixture);
    expect(statSync(hook).mode & 0o111).not.toBe(0);
  });

  it("detects an edited hook even when its manifest digest was edited to match", () => {
    // The manifest lives in the agent's own clone. Trusting its digests let an
    // agent rewrite pre-commit to `exit 0`, restamp it, and be certified healthy.
    const { clone } = installed();
    const hook = join(clone, ".git", "hooks", "pre-commit");
    const forged = "#!/usr/bin/env bash\nexit 0\n";
    writeFileSync(hook, forged);
    chmodSync(hook, 0o755);
    const manifest = manifestOf(clone);
    writeFileSync(
      join(clone, ".git", "hooks", "coord-hooks.json"),
      JSON.stringify({ ...manifest, files: { ...manifest.files, "pre-commit": createHash("sha256").update(forged).digest("hex") } }, null, 2)
    );

    expect(
      inspectCloneHooks({ clone, installRoot: repoRoot, installCommit: manifest.sourceCommit })
    ).toEqual({ kind: "modified", files: ["pre-commit"] });
  });

  it("refuses a manifest that names a path outside the hooks directory", () => {
    const { clone, fixture } = installed();
    const victim = join(fixture.workspaceRoot, "victim.txt");
    writeFileSync(victim, "not coordination's to delete\n");
    const manifest = manifestOf(clone);
    writeFileSync(
      join(clone, ".git", "hooks", "coord-hooks.json"),
      JSON.stringify(
        {
          ...manifest,
          files: { ...manifest.files, "../../../victim.txt": createHash("sha256").update(readFileSync(victim)).digest("hex") }
        },
        null,
        2
      )
    );

    const removal = removeCloneHooks(clone, { dryRun: false });
    expect(removal.removed).toEqual([]);
    expect(removal.kept.join(" ")).toContain("malformed");
    expect(existsSync(victim)).toBe(true);
  });
});

describe("pre-existing hooks", () => {
  const sentinelBody = (marker: string): string =>
    `#!/usr/bin/env bash\nprintf 'ran\\n' >> "${marker}"\nexit 0\n`;

  it("preserves and chains a hook the clone already had, and restores it on uninstall", () => {
    const { clone, fixture } = installed();
    const marker = join(fixture.workspaceRoot, "sentinel.log");
    const hook = join(clone, ".git", "hooks", "pre-commit");
    writeFileSync(hook, sentinelBody(marker));
    chmodSync(hook, 0o755);

    installAgain(fixture);
    expect(existsSync(`${hook}.coord-original`)).toBe(true);
    expect(manifestOf(clone).preserved).toEqual(["pre-commit"]);

    stageWork(clone);
    expect(tryGit(clone, "commit", "-m", "Claude: work").exitCode).toBe(0);
    expect(readFileSync(marker, "utf8")).toContain("ran");

    uninstall({
      coordRoot: fixture.coordRoot,
      productRoot: fixture.productRoot,
      deleteClones: false,
      wipeRuntime: false,
      deleteCoordination: false,
      force: false,
      dryRun: false,
      log: silence().log
    });
    expect(readFileSync(hook, "utf8")).toBe(sentinelBody(marker));
    expect(existsSync(`${hook}.coord-original`)).toBe(false);
  });
});

describe("pre-push gates", () => {
  const ownedBranchWithCommit = (clone: string): void => {
    stageWork(clone);
    git(clone, "commit", "-qm", "Claude: work");
  };

  it("refuses the shared branch, a peer's branch, force-pushes, and deletions", () => {
    // These four are the whole point of the hook and their failure mode is
    // silent, so they are pinned rather than assumed.
    const { clone } = installed();
    ownedBranchWithCommit(clone);

    const toMain = tryGit(clone, "push", "origin", "issue-1/claude:main");
    expect(toMain.exitCode).not.toBe(0);
    expect(toMain.stderr).toContain("Human/PR merge only");

    const toFinal = tryGit(clone, "push", "origin", "issue-1/claude:issue-1/final");
    expect(toFinal.exitCode).not.toBe(0);

    const toPeer = tryGit(clone, "push", "origin", "issue-1/claude:issue-1/codex");
    expect(toPeer.exitCode).not.toBe(0);
    expect(toPeer.stderr).toContain("belongs to agent 'codex'");

    expect(tryGit(clone, "push", "-q", "origin", "issue-1/claude").exitCode).toBe(0);

    git(clone, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(clone, "cmd", "other.go"), "package main\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "Claude: rewritten");
    const forced = tryGit(clone, "push", "--force", "origin", "issue-1/claude");
    expect(forced.exitCode).not.toBe(0);
    expect(forced.stderr).toContain("force-push");

    const deleted = tryGit(clone, "push", "origin", ":issue-1/claude");
    expect(deleted.exitCode).not.toBe(0);
    expect(deleted.stderr).toContain("deleting remote branches");
  });

  it("gates every push when the project declared no critical paths", () => {
    // Absence of a narrowing declaration must widen the gate, never silence it.
    const { clone } = installed({
      precommit: [],
      prepush: [{ name: "must-fail", argv: ["false"] }]
    });
    ownedBranchWithCommit(clone);
    const pushed = tryGit(clone, "push", "origin", "issue-1/claude");
    expect(pushed.exitCode).not.toBe(0);
    expect(`${pushed.stdout}${pushed.stderr}`).toContain("must-fail");
  });
});
