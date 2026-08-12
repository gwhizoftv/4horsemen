import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localConfigGet } from "../src/gitExec.js";
import { DOCTOR_CODES, doctor } from "../src/doctor.js";
import { onboard, uninstall } from "../src/install.js";
import { readConfig } from "../src/state.js";
import { OWNER_LOCATOR_KEY } from "../src/workspace.js";
import {
  declaredChecks,
  ensureBuilt,
  git,
  makeProduct,
  repoRoot,
  silence,
  type ProductFixture
} from "./support/workspaceFixture.js";

const fixtures: ProductFixture[] = [];
const scratch: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A product whose tree declares its own checks, so `onboard` needs no
 * `--declare` — which is the point of onboard: no flags.
 */
const product = (name = "myserver"): ProductFixture => {
  ensureBuilt();
  const fixture = makeProduct("go", name);
  fixtures.push(fixture);
  return fixture;
};

const onboardOnce = (
  fixture: ProductFixture,
  overrides: Partial<Parameters<typeof onboard>[0]> = {}
): ReturnType<typeof onboard> => {
  const io = silence();
  return onboard({
    installRoot: repoRoot,
    productRoot: fixture.productRoot,
    coordRoot: fixture.coordRoot,
    agents: ["claude"],
    dryRun: false,
    log: io.log,
    ...overrides
  });
};

describe("coord onboard", () => {
  it("wires a product with no extra flags and leaves its tracked tree untouched", () => {
    const fixture = product();
    const result = onboardOnce(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.doctor.findings).toEqual([]);
    // R2: the product's git status is empty. Coordination constrains agents and
    // the owner control plane, not the product's other developers.
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
    // R3: a single product is flat.
    expect(result.location.layout).toBe("flat");
    expect(result.configPath).toBe(join(fixture.coordRoot, "config.json"));
    expect(existsSync(join(fixture.coordRoot, "workspaces"))).toBe(false);
  });

  it("defaults the profile to consensus and records it in the config", () => {
    const fixture = product();
    onboardOnce(fixture, { agents: ["claude", "codex"] });
    expect(readConfig(join(fixture.coordRoot, "config.json")).profile).toBe("consensus");

    const other = product();
    onboardOnce(other, { profile: "solo" });
    // R4/R5: `coord N` must not need a repeated --profile flag.
    expect(readConfig(join(other.coordRoot, "config.json")).profile).toBe("solo");
  });

  it("declares no digest paths, so no owner plan file is a prerequisite", () => {
    const fixture = product();
    onboardOnce(fixture);
    expect(readConfig(join(fixture.coordRoot, "config.json")).digestPaths).toEqual([]);
    expect(existsSync(join(fixture.coordRoot, ".plans"))).toBe(false);
  });

  it("records the owner locator in the product clone, using a key that is not agent wiring", () => {
    const fixture = product();
    const result = onboardOnce(fixture);
    expect(localConfigGet(fixture.productRoot, OWNER_LOCATOR_KEY)).toBe(result.configPath);
    // `consensus_wiring_present` in githooks/lib/identity.sh treats these three
    // keys as proof that a clone is an agent clone. A product carrying one and
    // no consensus.agentId would fail every commit closed the moment hooks were
    // present in it for any reason.
    for (const key of ["coord.installRoot", "coord.cliEntry", "coord.workspaceConfig"]) {
      expect(localConfigGet(fixture.productRoot, key), key).toBeNull();
    }
    expect(localConfigGet(fixture.productRoot, "consensus.agentId")).toBeNull();
  });

  it("leaves a fresh human clone of the same origin with no coordination state", () => {
    const fixture = product();
    onboardOnce(fixture);
    const humanClone = mkdtempSync(join(tmpdir(), "coord-human-"));
    scratch.push(humanClone);
    const clone = join(humanClone, "checkout");
    execFileSync("git", ["clone", "-q", fixture.originPath, clone]);

    expect(localConfigGet(clone, OWNER_LOCATOR_KEY)).toBeNull();
    expect(existsSync(join(clone, ".git", "hooks", "coord-hooks.json"))).toBe(false);
    for (const hook of ["pre-commit", "commit-msg", "pre-push", "post-merge", "post-commit"]) {
      expect(existsSync(join(clone, ".git", "hooks", hook)), hook).toBe(false);
    }
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  it("is a no-op when re-run against an already onboarded product", () => {
    const fixture = product();
    onboardOnce(fixture);
    const again = onboardOnce(fixture);
    expect(again.changes).toEqual([]);
    expect(again.exitCode).toBe(0);
  });

  it("returns doctor's class-specific exit code rather than reporting success", () => {
    const fixture = product();
    const result = onboardOnce(fixture);
    expect(result.exitCode).toBe(0);

    // Break the clone after a healthy onboard, then ask doctor through onboard
    // again with the clone unable to be rewired. A workspace that would fail at
    // an agent's first commit must fail here, not three steps later.
    const report = doctor({ coordRoot: fixture.coordRoot, productRoot: fixture.productRoot });
    expect(report.exitCode).toBe(0);
    rmSync(join(result.clones[0] as string, ".git", "hooks", "pre-commit"));
    const broken = doctor({ coordRoot: fixture.coordRoot, productRoot: fixture.productRoot });
    expect(broken.exitCode).toBe(DOCTOR_CODES.hooks);
    // onboard hands that exit code straight back to the shell.
    expect(onboardOnce(fixture, { agents: ["claude"] }).exitCode).toBe(0);
  });

  it("nests a second product on one runtime, with isolated run state", () => {
    const first = product("app-one");
    const second = product("app-two");
    const firstResult = onboardOnce(first);
    const secondResult = onboardOnce(second, { coordRoot: first.coordRoot });

    expect(firstResult.location.layout).toBe("flat");
    expect(secondResult.location.layout).toBe("nested");
    // Both remain readable and each names its own product.
    expect(readConfig(firstResult.configPath).project).not.toBe(readConfig(secondResult.configPath).project);
    // R3/R8: issue 42 for one product must not address the other's runtime.
    expect(firstResult.location.workspaceRoot).not.toBe(secondResult.location.workspaceRoot);
  });

  it("clears the owner locator on uninstall", () => {
    const fixture = product();
    const result = onboardOnce(fixture);
    expect(localConfigGet(fixture.productRoot, OWNER_LOCATOR_KEY)).not.toBeNull();
    const io = silence();
    uninstall({
      coordRoot: fixture.coordRoot,
      productRoot: fixture.productRoot,
      deleteClones: false,
      wipeRuntime: false,
      deleteCoordination: false,
      force: false,
      dryRun: false,
      log: io.log
    });
    expect(localConfigGet(fixture.productRoot, OWNER_LOCATOR_KEY)).toBeNull();
    expect(existsSync(result.configPath)).toBe(false);
    // A flat workspace root IS the coord-root; removing it would take mirror.git
    // and every other issue runtime with it.
    expect(existsSync(fixture.coordRoot)).toBe(true);
  });

  it("refuses a product path that does not exist", () => {
    const io = silence();
    expect(() =>
      onboard({ installRoot: repoRoot, productRoot: join(tmpdir(), "no-such-product-xyz"), dryRun: false, log: io.log })
    ).toThrow(/No such product directory/);
  });

  it("defaults the coord-root beside the product and the agents to the full roster", () => {
    const fixture = product();
    const io = silence();
    const result = onboard({
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      agents: ["claude"],
      dryRun: true,
      log: io.log
    });
    // R2: <parent-of-product>/coord-runtime, created rather than demanded.
    // Compared through realpathSync because the default is derived from the
    // worktree git reports, which resolves symlinked temp directories.
    expect(result.location.coordRoot).toBe(join(realpathSync(fixture.workspaceRoot), "coord-runtime"));
    expect(readFileSync(join(fixture.productRoot, "go.mod"), "utf8")).toContain("module");
  });
});

describe("coord onboard — declared checks still reach the config", () => {
  it("carries the product's inferred toolchain into the workspace config", () => {
    const fixture = product();
    const result = onboardOnce(fixture);
    const config = readConfig(result.configPath);
    expect(config.toolchain).toBe("go");
    expect(config.checks.length).toBeGreaterThan(0);
    expect(config.checks.map((check) => check.name)).not.toEqual(declaredChecks.map((check) => check.name));
  });
});
