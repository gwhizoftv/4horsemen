import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
      })
    );
    expect(missing).toEqual(["definitely-not-a-real-binary-xyz"]);
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
