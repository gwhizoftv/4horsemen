import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { onboard, uninstall } from "../src/install.js";
import { OWNER_WORKSPACE_CONFIG_KEY, readOwnerWorkspaceConfig } from "../src/workspace.js";
import {
  declaredChecks,
  ensureBuilt,
  fakeGitHubOrigin,
  git,
  makeProduct,
  passingVerify,
  repoRoot,
  silence,
  writeDeclaration,
  type ProductFixture
} from "./support/workspaceFixture.js";

const fixtures: ProductFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe("coord onboard", () => {
  it("installs defaults, records the locator, and leaves product status clean", () => {
    ensureBuilt();
    const fixture = makeProduct();
    fixtures.push(fixture);
    const coordRoot = join(fixture.workspaceRoot, "coord-runtime");
    const result = onboard({
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      coordRoot,
      agents: ["claude"],
      origin: fakeGitHubOrigin("myserver"),
      declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }),
      log: silence().log
    });
    expect(result.configPath).toBe(join(coordRoot, "config.json"));
    expect(result.location.layout).toBe("flat");
    expect(readOwnerWorkspaceConfig(fixture.productRoot)).toBe(result.configPath);
    expect(git(fixture.productRoot, "config", "--local", "--get", OWNER_WORKSPACE_CONFIG_KEY)).toBe(result.configPath);
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
    expect(JSON.parse(readFileSync(result.configPath, "utf8")).digestPaths).toEqual([]);
    expect(JSON.parse(readFileSync(result.configPath, "utf8")).profile).toBe("consensus");
    expect(doctor({ coordRoot, productRoot: fixture.productRoot }).exitCode).toBe(0);

    uninstall({
      coordRoot,
      productRoot: fixture.productRoot,
      deleteClones: false,
      wipeRuntime: false,
      deleteCoordination: false,
      force: false,
      dryRun: false,
      log: silence().log
    });
    expect(readOwnerWorkspaceConfig(fixture.productRoot)).toBeNull();
    expect(existsSync(result.configPath)).toBe(false);
  });

  it("reports startCompatibility when origin is not github.com", () => {
    ensureBuilt();
    const fixture = makeProduct();
    fixtures.push(fixture);
    const coordRoot = join(fixture.workspaceRoot, "coord-runtime");
    onboard({
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      coordRoot,
      agents: ["claude"],
      declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }),
      log: silence().log
    });
    const report = doctor({ coordRoot, productRoot: fixture.productRoot });
    expect(report.findings.some((item) => item.class === "startCompatibility")).toBe(true);
  });
});
