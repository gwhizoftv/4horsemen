import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HookPolicyError,
  renderHookScope,
  runVerifyPhase,
  unresolvableCommands,
  verifyCommands
} from "../src/hookPolicy.js";
import { proposeProjectPolicy } from "../src/setupWorkspace.js";
import { applyManagedBlock, ManagedBlockError, removeManagedBlock } from "../src/productIgnore.js";
import { coordinatorConfigSchema, workspaceDeclarationSchema, type CoordinatorConfig } from "../src/state.js";
import { repoRoot } from "./support/workspaceFixture.js";

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
  it("keeps config.product.example.json parseable by the driver's own schema", () => {
    const example = JSON.parse(readFileSync(join(repoRoot, "config.product.example.json"), "utf8")) as unknown;
    expect(coordinatorConfigSchema.safeParse(example).success).toBe(true);
  });

  it("ships the public baseline without machine-specific paths or private-install wording", () => {
    for (const name of ["CONTRIBUTING.md", "SECURITY.md"]) {
      expect(existsSync(join(repoRoot, name)), name).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { license?: string };
    expect(manifest.license).toBe("MIT");

    const published = [
      "README.md",
      ...readdirSync(join(repoRoot, "docs"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => join("docs", name)),
      "config.example.json",
      "config.product.example.json",
      join("scripts", "bootstrap.sh")
    ];
    for (const name of published) {
      const body = readFileSync(join(repoRoot, name), "utf8");
      expect(body, name).not.toMatch(/\/Volumes\/|\/Users\/[A-Za-z]/);
      expect(body, name).not.toMatch(/\b(?:repo|repository) is private\b|Private repos/i);
    }
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
