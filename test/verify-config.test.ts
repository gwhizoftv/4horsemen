import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctorChecks } from "../src/doctor.js";
import { coordinatorConfigSchema } from "../src/state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verify config", () => {
  it("treats missing verify as distinct from explicit empty verify for doctor PATH checks", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-verify-"));
    roots.push(root);
    const configPath = join(root, "config.json");

    const withEmpty = coordinatorConfigSchema.parse({
      project: "x",
      origin: "https://example.com/x.git",
      agents: [{ id: "cursor", root: root, launcher: "start-cursor.sh", delivery: "pull" }],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [".plans/issue-{issue}/plan.md"],
      checks: [{ name: "true", argv: ["true"] }],
      verify: { precommit: [], prepush: [] }
    });
    writeFileSync(configPath, JSON.stringify(withEmpty));
    const emptyReport = runDoctorChecks({
      configPath,
      config: withEmpty,
      requirePathCommands: true
    });
    expect(emptyReport.findings.some((f) => f.code === "missing-command")).toBe(false);

    const withMissingCmd = coordinatorConfigSchema.parse({
      ...withEmpty,
      verify: {
        precommit: [{ name: "nope", argv: ["coord-verify-missing-binary-xyz"] }],
        prepush: []
      }
    });
    const missingReport = runDoctorChecks({
      configPath,
      config: withMissingCmd,
      requirePathCommands: true
    });
    expect(missingReport.ok).toBe(false);
    expect(missingReport.findings.some((f) => f.code === "missing-command")).toBe(true);

    const absentVerify = coordinatorConfigSchema.parse({
      project: "x",
      origin: "https://example.com/x.git",
      agents: [{ id: "cursor", root: root, launcher: "start-cursor.sh", delivery: "pull" }],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [".plans/issue-{issue}/plan.md"],
      checks: [{ name: "true", argv: ["true"] }]
    });
    expect(absentVerify.verify).toBeUndefined();
  });

  it("accepts non-Node verify argv shapes", () => {
    const config = coordinatorConfigSchema.parse({
      project: "myserver",
      origin: "https://example.com/myserver.git",
      agents: [{ id: "cursor", root: "../myserver-cursor", launcher: "start-cursor.sh", delivery: "pull" }],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [".plans/issue-{issue}/plan.md"],
      verify: {
        precommit: [
          { name: "vet", argv: ["go", "vet", "./..."] },
          { name: "test", argv: ["go", "test", "./..."] }
        ],
        prepush: [{ name: "build", argv: ["go", "build", "./..."] }]
      },
      workflowCriticalPrefixes: ["cmd/", "internal/"],
      workflowCriticalFiles: ["go.mod", "go.sum"],
      checks: [{ name: "test", argv: ["go", "test", "./..."] }]
    });
    expect(config.verify?.precommit).toHaveLength(2);
    expect(config.workflowCriticalFiles).toContain("go.mod");
  });
});
