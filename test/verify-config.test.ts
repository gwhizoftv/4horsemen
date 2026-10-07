import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HookPolicyError,
  renderHookScope,
  runVerifyPhase,
  unresolvableCommands,
  verifyCommands
} from "../src/hookPolicy.js";
import { buildWorkspaceConfig, proposeProjectPolicy } from "../src/setupWorkspace.js";
import {
  classifyChanges,
  inspectOutgoingChanges,
  inspectRangeChanges,
  inspectStagedChanges,
  isCoordinationEvidencePath,
  selectCandidateVerification,
  selectVerification
} from "../src/changeClassification.js";
import { renderAgentsProtocolBlock } from "../src/agentsProtocol.js";
import { applyManagedBlock, ManagedBlockError, removeManagedBlock } from "../src/productIgnore.js";
import { coordinatorConfigSchema, workspaceDeclarationSchema, type CoordinatorConfig } from "../src/state.js";
import { git, makeProduct, repoRoot } from "./support/workspaceFixture.js";
import fastConfig from "../vitest.config.js";
import systemConfig from "../vitest.system.config.js";
import e2eConfig from "../vitest.e2e.config.js";

const config = (overrides: Record<string, unknown> = {}): CoordinatorConfig =>
  coordinatorConfigSchema.parse({
    project: "myserver",
    origin: "https://github.com/example/myserver.git",
    agents: [{ id: "claude", root: "../myserver-claude", launcher: "start-claude.sh" }],
    branch: "issue-{issue}/{agent}",
    checks: [{ name: "test", argv: ["go", "test", "./..."] }],
    ...overrides
  });

describe("declared verification", () => {
  it("runs argument vectors from any ecosystem, in declared order", () => {
    const ran: string[][] = [];
    const result = runVerifyPhase({
      clone: "/tmp/clone",
      config: config({
        verify: {
          precommit: [
            { name: "vet", argv: ["go", "vet", "./..."] },
            { name: "test", argv: ["cargo", "test"] }
          ],
          prepush: []
        }
      }),
      phase: "precommit",
      log: () => undefined,
      runner: (command) => {
        ran.push([...command.argv]);
        return 0;
      }
    });
    expect(result.ok).toBe(true);
    expect(ran).toEqual([
      ["go", "vet", "./..."],
      ["cargo", "test"]
    ]);
  });

  it("stops at the first failure and names the command that failed", () => {
    const ran: string[] = [];
    const result = runVerifyPhase({
      clone: "/tmp/clone",
      config: config({
        verify: {
          precommit: [
            { name: "first", argv: ["make", "lint"] },
            { name: "second", argv: ["make", "test"] }
          ],
          prepush: []
        }
      }),
      phase: "precommit",
      log: () => undefined,
      runner: (command) => {
        ran.push(command.name);
        return command.name === "first" ? 3 : 0;
      }
    });
    expect(result).toMatchObject({ ok: false, exitCode: 3 });
    expect(ran).toEqual(["first"]);
  });

  it("treats a missing declaration as an error and an explicit empty one as consent", () => {
    expect(() => verifyCommands(config(), "precommit")).toThrow(HookPolicyError);
    expect(() => verifyCommands(config(), "precommit")).toThrow(/declares no `verify`/);

    const optedOut = config({ verify: { precommit: [], prepush: [] } });
    expect(verifyCommands(optedOut, "precommit")).toEqual([]);
    expect(runVerifyPhase({ clone: "/tmp/clone", config: optedOut, phase: "precommit", log: () => undefined })).toEqual({
      ok: true
    });
  });

  it("reports declared executables that are not on PATH", () => {
    const missing = unresolvableCommands(
      config({
        checks: [{ name: "test", argv: ["true"] }],
        verify: {
          precommit: [{ name: "nope", argv: ["definitely-not-a-real-binary-xyz"] }],
          prepush: []
        }
      }),
      repoRoot
    );
    expect(missing).toEqual(["definitely-not-a-real-binary-xyz"]);
  });

  it("resolves a relative command against the clone, and requires it to be executable", () => {
    const clone = mkdtempSync(join(tmpdir(), "coord-argv-"));
    try {
      const declared = config({ checks: [{ name: "local", argv: ["./scripts/check.sh"] }] });
      // Absent: reported wherever doctor happens to be invoked from.
      expect(unresolvableCommands(declared, clone)).toEqual(["./scripts/check.sh"]);

      // Present but not executable is still not something a hook can spawn.
      mkdirSync(join(clone, "scripts"), { recursive: true });
      writeFileSync(join(clone, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      expect(unresolvableCommands(declared, clone)).toEqual(["./scripts/check.sh"]);

      chmodSync(join(clone, "scripts", "check.sh"), 0o755);
      expect(unresolvableCommands(declared, clone)).toEqual([]);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("pre-push scope", () => {
  it("renders declared prefixes and files as line-oriented output", () => {
    expect(
      renderHookScope(
        config({ workflowCriticalPrefixes: ["cmd/", "internal/"], workflowCriticalFiles: ["go.mod"] })
      )
    ).toBe("prefix\tcmd/\nprefix\tinternal/\nfile\tgo.mod\n");
  });

  it("renders nothing when no narrowing was declared, so the hook gates everything", () => {
    expect(renderHookScope(config())).toBe("");
  });

  it("rejects entries that would be ambiguous across the hook boundary", () => {
    expect(() => config({ workflowCriticalPrefixes: ["two words/"] })).toThrow();
  });
});

describe("installer proposals", () => {
  it("proposes from the project's own tree, and proposes nothing it cannot recognise", () => {
    // The coordination repo is a pnpm project, so its own proposal says so.
    const own = proposeProjectPolicy(repoRoot);
    expect(own.toolchain).toBe("pnpm");
    expect(own.verify?.precommit[0]?.argv).toEqual(["pnpm", "run", "check:fast"]);
    expect(own.verify?.prepush[0]?.argv).toEqual(["pnpm", "run", "test:e2e"]);

    // A directory with no recognisable ecosystem gets no proposal at all, so the
    // installer refuses rather than inventing checks nobody declared.
    const unknown = proposeProjectPolicy(join(repoRoot, "test", "support"));
    expect(unknown.verify).toBeUndefined();
    expect(unknown.checks).toBeUndefined();
  });

  it("omits verify when nothing was recognized, rather than writing an opt-out", () => {
    // An empty verify is the operator's explicit "this project has no local
    // checks". A proposal that found nothing must not sign that on their behalf.
    const root = mkdtempSync(join(tmpdir(), "coord-propose-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }));
      expect(proposeProjectPolicy(root).verify).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const makeRoot = mkdtempSync(join(tmpdir(), "coord-propose-"));
    try {
      writeFileSync(join(makeRoot, "Makefile"), "test:\n\techo ok\n");
      const proposal = proposeProjectPolicy(makeRoot);
      expect(proposal.toolchain).toBe("make");
      expect(proposal.verify).toBeUndefined();
    } finally {
      rmSync(makeRoot, { recursive: true, force: true });
    }
  });

  it("proposes non-Node argument vectors for non-Node trees", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-propose-"));
    try {
      writeFileSync(join(root, "go.mod"), "module example.com/x\n");
      const go = proposeProjectPolicy(root);
      expect(go.toolchain).toBe("go");
      expect(go.verify?.precommit[0]?.argv).toEqual(["go", "vet", "./..."]);
      expect(go.workflowCriticalFiles).toEqual(["go.mod", "go.sum"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const cargoRoot = mkdtempSync(join(tmpdir(), "coord-propose-"));
    try {
      writeFileSync(join(cargoRoot, "Cargo.toml"), "[package]\nname = \"x\"\n");
      const cargo = proposeProjectPolicy(cargoRoot);
      expect(cargo.toolchain).toBe("cargo");
      expect(cargo.checks?.[0]?.argv).toEqual(["cargo", "test"]);
    } finally {
      rmSync(cargoRoot, { recursive: true, force: true });
    }
  });
});

describe("shipped examples", () => {
  it("aligns tracked and refreshed verification instructions with evidence exemptions", () => {
    const tracked = readFileSync(join(repoRoot, "AGENTS.md"), "utf8").split("<!-- coordination protocol")[0]!;
    const protocol = renderAgentsProtocolBlock(repoRoot);
    for (const content of [tracked, protocol, tracked + protocol]) {
      expect(content).not.toContain("Run `pnpm check:fast` before commits");
      expect(content).toMatch(/not a manual product\s+suite/);
      expect(content).toMatch(/hook owns (?:that|its) mandatory check/);
      expect(content).toMatch(/investigate (?:a finding|findings)/);
    }
  });

  it("declares a focused docs profile, not a Markdown-wide exemption", () => {
    const example = coordinatorConfigSchema.parse(JSON.parse(readFileSync(join(repoRoot, "config.example.json"), "utf8")));
    expect(example.documentation?.paths).toContain("README.md");
    expect(example.documentation?.paths).not.toContain("templates/product/AGENTS.protocol.md");
    expect(example.documentation?.checks.at(-1)?.argv).toEqual(["pnpm", "check:docs"]);
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:docs"]).toContain("shipped examples|verification instructions");
    expect(pkg.scripts["check:docs"]).not.toContain("check:fast");
  });
  it("ships release-preparation docs without machine-specific paths or private-install wording", () => {
    // The owner deferred LICENSE; this change prepares, but does not complete, the release.
    for (const file of ["CONTRIBUTING.md", "SECURITY.md"]) {
      expect(readFileSync(join(repoRoot, file), "utf8").trim(), file).not.toBe("");
    }
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { private?: boolean };
    expect(pkg.private).toBe(true);
    const files = [
      "README.md",
      ...readdirSync(join(repoRoot, "docs")).filter((file) => file.endsWith(".md")).map((file) => `docs/${file}`),
      "config.example.json",
      "config.product.example.json",
      "scripts/bootstrap.sh"
    ];
    for (const file of files) {
      const content = readFileSync(join(repoRoot, file), "utf8");
      expect(content, file).not.toMatch(/\/Volumes\/|\/Users\/[A-Za-z]/);
      expect(content, file).not.toMatch(/\b(?:repo|repository) is private\b|Private repos/i);
    }
  });

  it("declares coordinator verification whose final components equal pnpm check, over a disjoint test partition", () => {
    const example = coordinatorConfigSchema.parse(JSON.parse(readFileSync(join(repoRoot, "config.example.json"), "utf8")));
    expect(example.verification?.mode).toBe("coordinator");
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const leaves = (script: string): string[] => pkg.scripts[script]!.startsWith("pnpm ")
      ? pkg.scripts[script]!.split(" && ").flatMap((step) => leaves(step.replace(/^pnpm (?:run )?/, "")))
      : [script];
    expect(example.checks.map((check) => check.name).filter((name) => name !== "install").sort()).toEqual(leaves("check").sort());

    const tests = readdirSync(join(repoRoot, "test")).filter((file) => file.endsWith(".test.ts")).map((file) => `test/${file}`);
    const suites = [fastConfig, systemConfig, e2eConfig].map((config) => config.test!);
    for (const file of tests) {
      const owners = suites.filter((suite) => (suite.include ?? []).some((glob) => matchesGlob(file, glob)) &&
        !(suite.exclude ?? []).some((glob) => matchesGlob(file, glob)));
      expect(owners, file).toHaveLength(1);
    }

    // Caching across evidence-only commits is sound only if no cached check reads evidence paths.
    const tsconfigs = ["tsconfig.json", "test/tsconfig.json"].flatMap((file) =>
      (JSON.parse(readFileSync(join(repoRoot, file), "utf8")) as { include: string[] }).include);
    const roots = [...tsconfigs, ...suites.flatMap((suite) => suite.include ?? []), ...pkg.scripts.lint!.split(" ").slice(1)];
    for (const root of roots) {
      const normalized = root.replace(/^(?:\.\.?\/)+/, "");
      expect(isCoordinationEvidencePath(normalized) || normalized.startsWith("."), root).toBe(false);
    }
  });

  it("keeps config.product.example.json parseable by the driver's own schema", () => {
    const example = JSON.parse(readFileSync(join(repoRoot, "config.product.example.json"), "utf8")) as unknown;
    expect(coordinatorConfigSchema.safeParse(example).success).toBe(true);
  });
});

describe("shared change classification", () => {
  const docs = {
    paths: ["README.md", "docs/tab\tand\nnewline.md", "docs/picture.png"],
    verify: { precommit: [{ name: "docs", argv: ["true"] }], prepush: [{ name: "docs", argv: ["true"] }] },
    checks: [{ name: "docs-final", argv: ["true"] }]
  };
  const policy = config({ documentation: docs });
  const changed = (...paths: string[]) => ({ identity: "test-input", changes: paths.map((path) => ({ status: "M", paths: [Buffer.from(path)] })) });

  it.each([".plans/issue-1/plan.md", ".code-reviews/issue-1/comparison.md", ".signals/issue-1/ready.json",
    ".amendments/issue-1/a.json", ".escalations/issue-1/e.md"])("skips evidence %s without a product runner", (path) => {
    const measurements: unknown[] = [];
    expect(runVerifyPhase({ clone: "/unused", config: policy, phase: "precommit", changes: changed(path),
      log: () => {}, record: (row) => measurements.push(row), runner: () => { throw new Error("must not run"); } })).toEqual({ ok: true });
    expect(measurements).toEqual([expect.objectContaining({ command: null, classification: "coordination", exitCode: 0 })]);
  });

  it("selects documentation consistently in every phase, retaining product fallback", () => {
    for (const phase of ["precommit", "prepush", "finalization"] as const) {
      const product = [{ name: "product", argv: ["false"] }];
      expect(selectVerification(changed("README.md", ".signals/issue-1/ready.json"), policy, phase, product).commands)
        .toEqual(phase === "finalization" ? docs.checks : docs.verify[phase]);
      expect(selectVerification(changed("README.md", "src/main.ts"), policy, phase, product).commands).toEqual(product);
      expect(selectVerification({ changes: null, identity: "missing" }, policy, phase, product).commands).toEqual(product);
      expect(selectVerification(changed("README.md"), config(), phase, product).commands).toEqual(product);
    }
  });

  it.each(["src/main.ts", "test/docs.test.ts", "githooks/pre-commit", "templates/product/AGENTS.protocol.md",
    "package.json", "pnpm-lock.yaml", "vitest.config.ts", "unknown.md", "evil\n.signals/a"])("keeps %s in product checks", (path) => {
    expect(classifyChanges(changed(path), policy).kind).toBe("product");
  });

  it("includes both rename sides, exact unusual names, and fails closed on malformed/type changes", () => {
    expect(classifyChanges(changed("docs/tab\tand\nnewline.md"), policy).kind).toBe("documentation");
    expect(classifyChanges({ identity: "rename", changes: [{ status: "R100", paths: [Buffer.from("src/x"), Buffer.from("README.md")] }] }, policy).kind).toBe("product");
    for (const status of ["U", "T", "?", " ", "R100"]) {
      expect(classifyChanges({ identity: "bad", changes: [{ status, paths: [Buffer.from("README.md")] }] }, policy).kind).toBe("product");
    }
    expect(classifyChanges({ identity: "empty", changes: [] }, policy).kind).toBe("product");
    expect(classifyChanges({ identity: "encoding", changes: [{ status: "M", paths: [Buffer.from([255])] }] }, policy).kind).toBe("product");
    expect(classifyChanges(changed("README.md"), config({ documentation: docs, workflowCriticalFiles: ["README.md"] })).kind).toBe("product");
    expect(classifyChanges(changed("docs/picture.png"), config({ documentation: docs, workflowCriticalPrefixes: ["docs/"] })).kind).toBe("product");
  });

  it("inspects index and actual push refs, not unstaged work or HEAD alone", () => {
    const fixture = makeProduct("plain");
    const root = fixture.productRoot;
    try {
      git(root, "fetch", "origin");
      const base = git(root, "rev-parse", "HEAD");
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "README.md"), "updated\n");
      writeFileSync(join(root, "docs/tab\tand\nnewline.md"), "unusual docs name\n");
      git(root, "add", "README.md", "docs/tab\tand\nnewline.md");
      writeFileSync(join(root, "source.ts"), "unstaged product\n");
      expect(classifyChanges(inspectStagedChanges(root), policy).kind).toBe("documentation");
      git(root, "commit", "-qm", "docs");
      const docPin = git(root, "rev-parse", "HEAD");
      const refs = `refs/heads/manual ${docPin} refs/heads/manual ${"0".repeat(40)}\n`;
      expect(classifyChanges(inspectOutgoingChanges(root, refs, "origin", "main"), policy).kind).toBe("documentation");
      expect(classifyChanges(inspectOutgoingChanges(root, refs, "missing", "main"), policy).kind).toBe("product");
      expect(classifyChanges(inspectRangeChanges(root, "f".repeat(40), docPin), policy).kind).toBe("product");
      git(root, "add", "source.ts");
      git(root, "commit", "-qm", "product");
      // A later HEAD is irrelevant when Git supplies the earlier outgoing pin.
      expect(classifyChanges(inspectOutgoingChanges(root, refs, "origin", "main"), policy).kind).toBe("documentation");
      const productPin = git(root, "rev-parse", "HEAD");
      const mixed = `${refs}refs/heads/other ${productPin} refs/heads/other ${base}\n`;
      expect(classifyChanges(inspectOutgoingChanges(root, mixed, "origin", "main"), policy).kind).toBe("product");
      expect(classifyChanges(inspectOutgoingChanges(root, "malformed", "origin", "main"), policy).kind).toBe("product");
      git(root, "mv", "source.ts", "docs/picture.png");
      expect(classifyChanges(inspectStagedChanges(root), policy).kind).toBe("product");
    } finally { fixture.cleanup(); }
  });

  it("selects candidate checks from declared coverage, pulling risk rules forward and expanding to the full gate", () => {
    const command = (name: string) => ({ name, argv: [name] });
    const start = {
      checks: ["install", "lint", "test:fast", "build", "test:e2e"].map(command),
      documentation: docs,
      verification: {
        mode: "coordinator" as const,
        maxConcurrentExpensive: 1,
        candidate: {
          checks: ["install", "lint", "test:fast"].map(command),
          covers: { prefixes: ["src/", "test/"], files: [] },
          rules: [
            { prefixes: ["githooks/"], files: [], add: ["test:e2e"] },
            { prefixes: [], files: ["pnpm-lock.yaml"], add: "all" as const }
          ]
        }
      }
    };
    const names = (input: Parameters<typeof selectCandidateVerification>[0]) =>
      selectCandidateVerification(input, start).commands.map((check) => check.name);
    const full = start.checks.map((check) => check.name);
    expect(names(changed(".signals/issue-1/ready.json"))).toEqual([]);
    expect(names(changed("README.md"))).toEqual(["docs-final"]);
    expect(names(changed("src/x.ts", ".plans/issue-1/plan.md"))).toEqual(["install", "lint", "test:fast"]);
    expect(names(changed("githooks/pre-push"))).toEqual(["install", "lint", "test:fast", "test:e2e"]);
    expect(names(changed("pnpm-lock.yaml"))).toEqual(full);
    expect(names(changed("tools/x"))).toEqual(full);
    expect(names({ identity: "rename", changes: [{ status: "R100", paths: [Buffer.from("src/a.ts"), Buffer.from("githooks/a")] }] }))
      .toEqual(["install", "lint", "test:fast", "test:e2e"]);
    expect(names({ identity: "encoding", changes: [{ status: "M", paths: [Buffer.from([255])] }] })).toEqual(full);
    expect(selectCandidateVerification({ identity: "missing", changes: null }, start)).toMatchObject({ expanded: true });
    expect(names({ identity: "missing", changes: null })).toEqual(full);
  });

  it("preserves an explicit docs profile through installation configuration", () => {
    const result = buildWorkspaceConfig({ project: "fixture", origin: "https://example.com/fixture.git", baseBranch: "main",
      agents: ["codex"], profile: "solo", cloneRoot: "/clones", workspaceDir: "/runtime", completesRoot: "/completes",
      declared: workspaceDeclarationSchema.parse({ documentation: docs }),
      proposal: { toolchain: "node", checks: [{ name: "product", argv: ["false"] }], workflowCriticalFiles: [], workflowCriticalPrefixes: [] }
    }, undefined);
    expect(result.documentation).toEqual(docs);
  });
});

describe("hook bodies", () => {
  const bodies = readdirSync(join(repoRoot, "githooks")).filter((name) => name !== "lib");

  it("branch on no ecosystem marker and grep the product for no script name", () => {
    for (const name of bodies) {
      const body = readFileSync(join(repoRoot, "githooks", name), "utf8");
      expect(body, name).not.toMatch(/package\.json/);
      expect(body, name).not.toMatch(/pnpm-lock\.yaml|package-lock\.json|yarn\.lock/);
      expect(body, name).not.toMatch(/Cargo\.toml|go\.mod/);
      expect(body, name).not.toMatch(/check:fast|test:e2e/);
    }
    expect(bodies.sort()).toEqual(["commit-msg", "post-commit", "post-merge", "pre-commit", "pre-push"]);
  });

  it("pass through rather than blocking when there is no agent identity", () => {
    for (const name of bodies) {
      expect(readFileSync(join(repoRoot, "githooks", name), "utf8"), name).toContain(
        '[[ "$CONSENSUS_AGENT_CLONE" == true ]] || exit 0'
      );
    }
  });
});

describe("workspace declaration", () => {
  it("accepts project policy and refuses to let a file redirect a clone", () => {
    expect(
      workspaceDeclarationSchema.safeParse({
        checks: [{ name: "test", argv: ["make", "test"] }],
        verify: { precommit: [], prepush: [] }
      }).success
    ).toBe(true);

    // Agent roots, origin, and the install stamp are derived from the install's
    // own arguments. A declaration file that tried to supply them is rejected
    // rather than quietly ignored.
    for (const forbidden of [
      { agents: [{ id: "claude", root: "/elsewhere", launcher: "x" }] },
      { origin: "https://example.com/other.git" },
      { coordination: { installRoot: "/elsewhere" } }
    ]) {
      expect(workspaceDeclarationSchema.safeParse(forbidden).success, JSON.stringify(forbidden)).toBe(false);
    }
  });

  it("carries coordinator verification through installation and refuses ambiguous command identities", () => {
    const verification = {
      mode: "coordinator",
      coordinated: { precommit: [{ name: "lint", argv: ["make", "lint"] }], prepush: [] },
      candidate: { checks: [{ name: "test", argv: ["make", "test"] }], covers: { prefixes: ["src/"] },
        rules: [{ prefixes: ["hooks/"], add: ["e2e"] }] }
    };
    const checks = [{ name: "test", argv: ["make", "test"] }, { name: "e2e", argv: ["make", "e2e"] }];
    const build = (declared: Record<string, unknown>) => buildWorkspaceConfig({ project: "fixture",
      origin: "https://example.com/fixture.git", baseBranch: "main", agents: ["codex"], profile: "solo", cloneRoot: "/clones",
      workspaceDir: "/runtime", completesRoot: "/completes", declared: workspaceDeclarationSchema.parse(declared),
      proposal: { toolchain: "make", checks, workflowCriticalFiles: [], workflowCriticalPrefixes: [] } }, undefined);
    expect(build({ checks, verification }).verification).toMatchObject({ mode: "coordinator", maxConcurrentExpensive: 1 });
    for (const invalid of [
      { ...verification, candidate: undefined },
      { ...verification, candidate: { ...verification.candidate, rules: [{ files: ["x"], add: ["undeclared"] }] } },
      { ...verification, candidate: { ...verification.candidate, checks: [{ name: "test", argv: ["make", "quick-test"] }] } }
    ]) {
      expect(() => build({ checks, verification: invalid }), JSON.stringify(invalid)).toThrow();
    }
  });
});

describe("managed ignore block", () => {
  it("returns every byte outside the block unchanged across a round trip", () => {
    // A product's own grouping is not coordination's to reformat: collapsing
    // blank lines made install/uninstall show a diff in a file it does not own.
    const original = "# group one\nbuild/\n\n\n# group two — deliberately separated\ndist/\n";
    const applied = applyManagedBlock(original, ["/start-*.sh"]);
    expect(applied.content).toContain("coordination managed block");
    expect(removeManagedBlock(applied.content).content).toBe(original);
  });

  it("is idempotent and refreshes in place", () => {
    const original = "build/\n";
    const once = applyManagedBlock(original, ["/start-*.sh"]).content;
    expect(applyManagedBlock(once, ["/start-*.sh"])).toMatchObject({ changed: false, content: once });
    const refreshed = applyManagedBlock(once, ["/start-*.sh", "tags"]).content;
    expect(removeManagedBlock(refreshed).content).toBe(original);
  });

  it("refuses an unterminated block instead of deleting the rest of the file", () => {
    const truncated =
      "keep me\n# >>> coordination managed block — coord install >>>\n/start-*.sh\nIMPORTANT-PRODUCT-RULE\n";
    expect(() => removeManagedBlock(truncated)).toThrow(ManagedBlockError);
    expect(() => applyManagedBlock(truncated, ["/start-*.sh"])).toThrow(/end marker/);
  });
});
