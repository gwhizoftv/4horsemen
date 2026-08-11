import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { install } from "../src/install.js";
import {
  declaredChecks,
  ensureBuilt,
  git,
  makeProduct,
  passingVerify,
  repoRoot,
  silence,
  tryGit,
  writeDeclaration,
  type ProductFixture
} from "./support/workspaceFixture.js";

/**
 * `--write-product --vendor` is the one path that puts coordination's hook
 * bodies into a product's tracked tree, so it is the one path that could undo
 * the two-mode rule. These tests exist to keep it from doing so.
 */

const fixtures: ProductFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

const product = (): ProductFixture => {
  ensureBuilt();
  const fixture = makeProduct();
  fixtures.push(fixture);
  return fixture;
};

const vendorInstall = (fixture: ProductFixture): ReturnType<typeof install> =>
  install({
    installRoot: repoRoot,
    productRoot: fixture.productRoot,
    coordRoot: fixture.coordRoot,
    agents: ["claude"],
    profile: "solo",
    declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }),
    writeProduct: true,
    vendor: true,
    bootstrap: false,
    dryRun: false,
    log: silence().log
  });

describe("opt-in vendoring into the product tree", () => {
  it("leaves a human clone able to commit even with the committed hooks switched on", () => {
    // The bodies fail closed on a missing identity, which is right for an agent
    // clone. They stay harmless here only because that decision keys on
    // coordination wiring, and a human clone has none. If it ever keyed on the
    // hooks' presence instead, this is the developer whose repository breaks.
    const fixture = product();
    vendorInstall(fixture);
    git(fixture.productRoot, "add", "-A");
    git(fixture.productRoot, "commit", "-qm", "adopt coordination");
    git(fixture.productRoot, "push", "-q", "origin", "main");

    const humanClone = join(fixture.workspaceRoot, "human");
    git(fixture.workspaceRoot, "clone", "-q", fixture.originPath, humanClone);
    git(humanClone, "config", "user.name", "Human");
    git(humanClone, "config", "user.email", "human@example.com");
    expect(existsSync(join(humanClone, "githooks", "pre-commit"))).toBe(true);

    // The curious developer who turns the committed hooks on.
    git(humanClone, "config", "--local", "core.hooksPath", "githooks");

    writeFileSync(join(humanClone, "notes.txt"), "human edit\n");
    git(humanClone, "add", "-A");
    const committed = tryGit(humanClone, "commit", "-qm", "no agent prefix at all");
    expect(committed.exitCode).toBe(0);
    expect(`${committed.stdout}${committed.stderr}`).not.toContain("HOOK BLOCKED");
  });

  it("refuses to replace a hook the product already tracks", () => {
    const fixture = product();
    mkdirSync(join(fixture.productRoot, "githooks"), { recursive: true });
    writeFileSync(join(fixture.productRoot, "githooks", "pre-commit"), "#!/bin/sh\n# the product's own\n");
    git(fixture.productRoot, "add", "-A");
    git(fixture.productRoot, "commit", "-qm", "product hooks");

    expect(() => vendorInstall(fixture)).toThrow(/Refusing to replace tracked product hooks/);
    expect(readFileSync(join(fixture.productRoot, "githooks", "pre-commit"), "utf8")).toContain("the product's own");
  });
});
