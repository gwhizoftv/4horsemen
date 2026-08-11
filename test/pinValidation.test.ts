import { afterEach, describe, expect, it } from "vitest";

import {
  displayGitPaths,
  inspectCommitRange,
  isCoordinationPath,
  isCurrentIssueCoordinationPath,
  parseNameStatusRecordsZ,
  parseNameStatusZ,
  validatePhasePin
} from "../src/pinValidation.js";
import { createGitFixture, type GitFixture } from "./gitFixture.js";

const fixtures: GitFixture[] = [];

const newFixture = (): GitFixture => {
  const fixture = createGitFixture();

  fixtures.push(fixture);

  return fixture;
};

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("parseNameStatusRecordsZ", () => {
  it("parses single-path records", () => {
    const bytes = Buffer.from("M\0src/a.ts\0A\0src/b.ts\0", "utf8");

    expect(parseNameStatusRecordsZ(bytes)).toEqual([
      { status: "M", paths: [Buffer.from("src/a.ts")] },
      { status: "A", paths: [Buffer.from("src/b.ts")] }
    ]);
  });

  it("retains both paths of a rename and a copy", () => {
    const bytes = Buffer.from("R100\0old.ts\0new.ts\0C75\0src.ts\0copy.ts\0", "utf8");
    const records = parseNameStatusRecordsZ(bytes);

    expect(records).toHaveLength(2);
    expect(records[0]?.paths.map((path) => path.toString("utf8"))).toEqual(["old.ts", "new.ts"]);
    expect(records[1]?.paths.map((path) => path.toString("utf8"))).toEqual(["src.ts", "copy.ts"]);
  });

  it("keeps paths containing newlines, spaces, and tabs intact", () => {
    const nasty = "src/we ird\nname\twith.ts";
    const bytes = Buffer.from(`M\0${nasty}\0`, "utf8");
    const records = parseNameStatusRecordsZ(bytes);

    expect(records).toHaveLength(1);
    expect(records[0]?.paths[0]?.toString("utf8")).toBe(nasty);
  });

  it("throws when a record has no path", () => {
    expect(() => parseNameStatusRecordsZ(Buffer.from("M\0", "utf8"))).toThrow(/malformed/i);
  });

  it("throws when a rename is missing its destination", () => {
    expect(() => parseNameStatusRecordsZ(Buffer.from("R100\0only.ts\0", "utf8"))).toThrow(
      /rename\/copy without its destination/i
    );
  });

  it("returns no records for empty output", () => {
    expect(parseNameStatusRecordsZ(Buffer.alloc(0))).toEqual([]);
  });

  it("flattens rename records in the compatibility view", () => {
    const bytes = Buffer.from("R100\0old.ts\0new.ts\0", "utf8");

    expect(parseNameStatusZ(bytes).map((path) => path.toString("utf8"))).toEqual(["old.ts", "new.ts"]);
  });
});

describe("path classification", () => {
  it("recognises coordination prefixes for the current issue only", () => {
    expect(isCurrentIssueCoordinationPath(Buffer.from(".plans/issue-1/plan.md"), 1)).toBe(true);
    expect(isCurrentIssueCoordinationPath(Buffer.from(".signals/issue-1/joined-claude.json"), 1)).toBe(true);
    expect(isCurrentIssueCoordinationPath(Buffer.from(".code-reviews/issue-1/r.md"), 1)).toBe(true);
    expect(isCurrentIssueCoordinationPath(Buffer.from(".plans/issue-2/plan.md"), 1)).toBe(false);
  });

  it("recognises any-issue coordination paths separately", () => {
    expect(isCoordinationPath(Buffer.from(".plans/issue-2/plan.md"))).toBe(true);
    expect(isCoordinationPath(Buffer.from("src/index.ts"))).toBe(false);
  });

  it("does not treat a lookalike prefix as a coordination path", () => {
    expect(isCoordinationPath(Buffer.from(".plansible/x.md"))).toBe(false);
  });

  it("renders paths as quoted UTF-8 for diagnostics", () => {
    expect(displayGitPaths([Buffer.from("a b.ts"), Buffer.from("c.ts")])).toBe('"a b.ts", "c.ts"');
  });
});

describe("inspectCommitRange", () => {
  it("reports the changed paths between two commits", () => {
    const fixture = newFixture();
    const base = fixture.commit("base", { "src/a.ts": "export const a = 1;\n" });
    const tip = fixture.commit("tip", { "src/b.ts": "export const b = 2;\n" });
    const inspected = inspectCommitRange(fixture.root, base, tip);

    expect(inspected.ok).toBe(true);

    if (inspected.ok) {
      expect(inspected.changes.map((change) => change.paths[0]?.toString("utf8"))).toEqual(["src/b.ts"]);
    }
  });

  it("reports missing-base for an unknown base commit", () => {
    const fixture = newFixture();
    const tip = fixture.commit("tip", { "src/a.ts": "1\n" });
    const inspected = inspectCommitRange(fixture.root, "0".repeat(40), tip);

    expect(inspected).toMatchObject({ ok: false, reason: "missing-base" });
  });

  it("reports missing-tip for an unknown tip commit", () => {
    const fixture = newFixture();
    const base = fixture.commit("base", { "src/a.ts": "1\n" });
    const inspected = inspectCommitRange(fixture.root, base, "0".repeat(40));

    expect(inspected).toMatchObject({ ok: false, reason: "missing-tip" });
  });

  it("reports not-ancestor when the base is not in the tip's history", () => {
    const fixture = newFixture();
    const base = fixture.commit("base", { "src/a.ts": "1\n" });

    fixture.git("checkout", "--quiet", "--orphan", "other");
    fixture.git("rm", "-rf", "--quiet", ".");

    const tip = fixture.commit("unrelated", { "src/c.ts": "3\n" });

    expect(inspectCommitRange(fixture.root, base, tip)).toMatchObject({
      ok: false,
      reason: "not-ancestor"
    });
  });
});

describe("validatePhasePin", () => {
  const subject = "Implementation signal";

  it("accepts a tip that only adds current-issue coordination files", () => {
    const fixture = newFixture();
    const pin = fixture.commit("implementation", { "src/feature.ts": "export const f = 1;\n" });
    const tip = fixture.commit("signal", {
      ".signals/issue-1/implementation-ready-claude.json": "{}\n"
    });

    expect(
      validatePhasePin({ root: fixture.root, ref: "origin/issue-1/claude", pin, tip, issue: 1, subject })
    ).toEqual({ ok: true });
  });

  it("accepts a pin equal to the tip", () => {
    const fixture = newFixture();
    const pin = fixture.commit("implementation", { "src/feature.ts": "1\n" });

    expect(
      validatePhasePin({ root: fixture.root, ref: "origin/issue-1/claude", pin, tip: pin, issue: 1, subject })
    ).toEqual({ ok: true });
  });

  it("rejects a pin that is not present in the repository", () => {
    const fixture = newFixture();
    const tip = fixture.commit("tip", { "src/a.ts": "1\n" });
    const result = validatePhasePin({
      root: fixture.root,
      ref: "origin/issue-1/claude",
      pin: "0".repeat(40),
      tip,
      issue: 1,
      subject
    });

    expect(result).toMatchObject({ ok: false, reason: "missing-pin" });

    if (!result.ok) {
      expect(result.details).toContain("do not bypass pin validation");
    }
  });

  it("rejects a rewritten history where the pin is no longer an ancestor", () => {
    const fixture = newFixture();
    const pin = fixture.commit("implementation", { "src/feature.ts": "1\n" });

    fixture.git("checkout", "--quiet", "--orphan", "rewritten");
    fixture.git("rm", "-rf", "--quiet", ".");

    const tip = fixture.commit("rewritten", { "src/feature.ts": "2\n" });
    const result = validatePhasePin({
      root: fixture.root,
      ref: "origin/issue-1/claude",
      pin,
      tip,
      issue: 1,
      subject
    });

    expect(result).toMatchObject({ ok: false, reason: "history-rewrite" });
  });

  it("rejects product changes after the pin", () => {
    const fixture = newFixture();
    const pin = fixture.commit("implementation", { "src/feature.ts": "1\n" });
    const tip = fixture.commit("sneaky", { "src/feature.ts": "2\n" });
    const result = validatePhasePin({
      root: fixture.root,
      ref: "origin/issue-1/claude",
      pin,
      tip,
      issue: 1,
      subject
    });

    expect(result).toMatchObject({ ok: false, reason: "post-pin-implementation-change" });

    if (!result.ok) {
      expect(result.details).toContain("src/feature.ts");
    }
  });

  it("rejects coordination changes belonging to another issue", () => {
    const fixture = newFixture();
    const pin = fixture.commit("implementation", { "src/feature.ts": "1\n" });
    const tip = fixture.commit("other issue", { ".plans/issue-2/plan.md": "# other\n" });
    const result = validatePhasePin({
      root: fixture.root,
      ref: "origin/issue-1/claude",
      pin,
      tip,
      issue: 1,
      subject
    });

    expect(result).toMatchObject({ ok: false, reason: "cross-issue-coordination-change" });
  });

  it("reports product changes ahead of cross-issue changes when both are present", () => {
    const fixture = newFixture();
    const pin = fixture.commit("implementation", { "src/feature.ts": "1\n" });
    const tip = fixture.commit("both", {
      "src/feature.ts": "2\n",
      ".plans/issue-2/plan.md": "# other\n"
    });
    const result = validatePhasePin({
      root: fixture.root,
      ref: "origin/issue-1/claude",
      pin,
      tip,
      issue: 1,
      subject
    });

    expect(result).toMatchObject({ ok: false, reason: "post-pin-implementation-change" });
  });

  it("rejects a renamed product file after the pin", () => {
    const fixture = newFixture();
    const pin = fixture.commit("implementation", { "src/feature.ts": "export const f = 1;\n" });

    fixture.git("mv", "src/feature.ts", "src/renamed.ts");
    fixture.git("commit", "--quiet", "-m", "rename");

    const result = validatePhasePin({
      root: fixture.root,
      ref: "origin/issue-1/claude",
      pin,
      tip: fixture.rev("HEAD"),
      issue: 1,
      subject
    });

    expect(result).toMatchObject({ ok: false, reason: "post-pin-implementation-change" });
  });
});
