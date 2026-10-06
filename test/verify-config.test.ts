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
  selectCandidateVerification,
  selectVerification,
  type CandidatePolicy
} from "../src/changeClassification.js";
import { renderAgentsProtocolBlock } from "../src/agentsProtocol.js";
import { applyManagedBlock, ManagedBlockError, removeManagedBlock } from "../src/productIgnore.js";
import { coordinatorConfigSchema, workspaceDeclarationSchema, type CoordinatorConfig } from "../src/state.js";
import { git, makeProduct, repoRoot } from "./support/workspaceFixture.js";

const config = (overrides: Record<string, unknown> = {}): CoordinatorConfig =>
  coordinatorConfigSchema.parse({
    project: "myserver",
    origin: "https://github.com/example/myserver.git",
    agents: [{ id: "claude", root: "../myserver-claude", launcher: "start-claude.sh" }],
    branch: "issue-{issue}/{agent}",
    checks: [{ name: "test", argv: ["go", "test", "./..."] }],
    ...overrides
  });

const exampleConfig = (): CoordinatorConfig =>
  coordinatorConfigSchema.parse(JSON.parse(readFileSync(join(repoRoot, "config.example.json"), "utf8")));

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

  it("keeps config.product.example.json parseable by the driver's own schema", () => {
    const example = JSON.parse(readFileSync(join(repoRoot, "config.product.example.json"), "utf8")) as unknown;
    expect(coordinatorConfigSchema.safeParse(example).success).toBe(true);
  });

  it("ships a coordinator-mode verification policy this driver can actually freeze", () => {
    const example = exampleConfig();
    expect(example.verification?.mode).toBe("coordinator");
    // The hooks keep only the cheap list; the suites move to the coordinator.
    expect(example.verification?.coordinated?.precommit.map((check) => check.name)).toEqual(["check:fast"]);
    expect(example.verification?.coordinated?.prepush).toEqual([]);
    expect(example.verification?.candidate?.covers.prefixes).toEqual(["src/", "test/"]);
    expect(example.verification?.maxConcurrentExpensive).toBe(1);
    // Every expensive command is also cacheable, or the limiter just serializes
    // work that would have been reused for free.
    for (const check of example.checks) {
      if (check.expensive === true) expect(check.cache, check.name).toBeDefined();
    }
  });

  /**
   * The coordinator gate runs `checks`, so that list has to be the same work
   * `pnpm check` runs — minus `install`, which the gate performs by
   * materializing the worktree rather than as a declared component.
   */
  it("composes checks from the same scripts the check script runs", () => {
    const scripts = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as
      { scripts: Record<string, string> }).scripts;
    const expand = (script: string): string[] =>
      script.split("&&").flatMap((part) => {
        const match = /^\s*pnpm (?:run )?([\w:.-]+)\s*$/.exec(part);
        if (match === null) return [part.trim()];
        const name = match[1] as string;
        const nested = scripts[name];
        return nested !== undefined && nested.split("&&").every((segment) => /^\s*pnpm (?:run )?[\w:.-]+\s*$/.test(segment))
          ? expand(nested)
          : [name];
      });
    expect(expand(scripts.check as string)).toEqual(
      exampleConfig().checks.map((check) => check.name).filter((name) => name !== "install")
    );
    expect(scripts.test).toContain("pnpm test:system");
  });

  /**
   * A file in no suite is never run; a file in two is run twice and reported
   * as both fast and expensive. Both make the candidate gate's selection lie.
   */
  it("assigns every test file to exactly one vitest suite", () => {
    const globsFrom = (file: string, key: "include" | "exclude"): string[] => {
      const match = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(readFileSync(join(repoRoot, file), "utf8"));
      return match === null ? [] : [...(match[1] as string).matchAll(/"([^"]+)"/g)].map((entry) => entry[1] as string);
    };
    const suites = {
      fast: { include: globsFrom("vitest.config.ts", "include"), exclude: globsFrom("vitest.config.ts", "exclude") },
      system: { include: globsFrom("vitest.system.config.ts", "include"), exclude: [] as string[] },
      e2e: { include: globsFrom("vitest.e2e.config.ts", "include"), exclude: [] as string[] }
    };
    const walk = (directory: string, prefix: string): string[] =>
      readdirSync(join(repoRoot, directory), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(directory, entry.name), `${prefix}${entry.name}/`)
          : entry.name.endsWith(".test.ts") ? [`${prefix}${entry.name}`] : []);
    const files = walk("test", "test/");
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const owners = Object.entries(suites).filter(([, suite]) =>
        suite.include.some((glob) => matchesGlob(file, glob)) &&
        !suite.exclude.some((glob) => matchesGlob(file, glob)));
      expect(owners.map(([name]) => name), file).toHaveLength(1);
    }
    // The system list is a literal, so a file deleted from the tree must not
    // linger in it either.
    for (const glob of [...suites.system.include, ...suites.e2e.include]) {
      expect(files, glob).toContain(glob);
    }
  });
});

describe("candidate verification selection", () => {
  const start = (): CandidatePolicy => {
    const example = exampleConfig();
    return {
      checks: example.checks,
      verification: example.verification,
      workflowCriticalPrefixes: example.workflowCriticalPrefixes,
      workflowCriticalFiles: example.workflowCriticalFiles,
      ...(example.documentation === undefined ? {} : { documentation: example.documentation })
    };
  };
  const changed = (...paths: string[]) =>
    ({ identity: "candidate-input", changes: paths.map((path) => ({ status: "M", paths: [Buffer.from(path)] })) });
  const names = (selection: ReturnType<typeof selectCandidateVerification>) => selection.commands.map((command) => command.name);
  const everything = ["install", "build", "lint", "typecheck", "test:fast", "test:system", "test:e2e"];
  const declared = ["install", "lint", "typecheck", "test:fast", "test:system"];

  it("runs the documentation checks for an allowlisted doc, and nothing for evidence", () => {
    expect(names(selectCandidateVerification(changed("README.md"), start()))).toEqual(["install", "check:docs"]);
    const evidence = selectCandidateVerification(changed(".signals/issue-1/ready.json"), start());
    expect(evidence).toMatchObject({ kind: "coordination", commands: [], expanded: false });
  });

  it("runs only the declared candidate set for a covered product path", () => {
    const selection = selectCandidateVerification(changed("src/runLoop.ts", "test/runLoop.test.ts"), start());
    expect(names(selection)).toEqual(declared);
    expect(selection.expanded).toBe(false);
  });

  it("adds exactly what a matching rule names, including across both sides of a rename", () => {
    expect(names(selectCandidateVerification(changed("githooks/pre-push"), start()))).toEqual([...declared, "test:e2e"]);
    const renamed = selectCandidateVerification(
      { identity: "rename", changes: [{ status: "R100", paths: [Buffer.from("src/a.ts"), Buffer.from("githooks/a")] }] },
      start()
    );
    expect(names(renamed)).toEqual([...declared, "test:e2e"]);
    expect(renamed.expanded).toBe(true);
  });

  it.each([
    ["a rule that demands everything", changed("pnpm-lock.yaml")],
    ["a path no rule claims and covers omits", changed("tools/x")],
    ["a path mixed with a covered one", changed("src/runLoop.ts", "tools/x")],
    ["an undecodable path", { identity: "encoding", changes: [{ status: "M", paths: [Buffer.from([255])] }] }],
    ["an indeterminate range", { identity: "missing", changes: null }]
  ])("expands to the full gate for %s", (_label, input) => {
    const selection = selectCandidateVerification(input, start());
    expect(names(selection)).toEqual(everything);
    expect(selection.expanded).toBe(true);
    expect(selection.reason).not.toBe("");
  });

  it("expands to the full gate when the issue froze no candidate policy", () => {
    const local = start();
    const selection = selectCandidateVerification(changed("src/runLoop.ts"), { ...local, verification: undefined });
    expect(names(selection)).toEqual(everything);
    expect(selection.reason).toBe("no candidate policy is declared");
  });

  it("keeps the input identity of what it classified, so receipts cannot be mis-keyed", () => {
    expect(selectCandidateVerification(changed("src/runLoop.ts"), start()).inputIdentity).toBe("candidate-input");
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

  it("preserves verification through buildWorkspaceConfig and refuses incomplete coordinator mode", () => {
    const verification = exampleConfig().verification;
    const result = buildWorkspaceConfig({
      project: "fixture", origin: "https://example.com/fixture.git", baseBranch: "main",
      agents: ["codex"], profile: "solo", cloneRoot: "/clones", workspaceDir: "/runtime", completesRoot: "/completes",
      declared: workspaceDeclarationSchema.parse({ verification, checks: exampleConfig().checks }),
      proposal: { toolchain: "node", checks: [{ name: "product", argv: ["false"] }], workflowCriticalFiles: [], workflowCriticalPrefixes: [] }
    }, undefined);
    expect(result.verification).toEqual(verification);
    expect(coordinatorConfigSchema.safeParse({ ...result, verification: { mode: "coordinator" } }).success).toBe(false);
    expect(coordinatorConfigSchema.safeParse({
      ...result,
      verification: {
        ...verification,
        candidate: {
          ...verification!.candidate!,
          rules: [{ prefixes: [], files: ["mystery.ts"], add: ["missing-check"] }]
        }
      }
    }).success).toBe(false);
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
