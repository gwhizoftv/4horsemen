import { afterEach, describe, expect, it } from "vitest";

import { verifyFinalization } from "../src/finalization.js";
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

/**
 * A consensus commit carrying product files plus this issue's coordination
 * files, which finalization is allowed to delete and nothing else.
 */
const seedConsensus = (fixture: GitFixture): string =>
  fixture.commit("consensus", {
    "src/feature.ts": "export const feature = 1;\n",
    ".plans/issue-1/plan.md": "# plan\n",
    ".plans/issue-1/review.md": "# review\n",
    ".signals/issue-1/joined-claude.json": "{}\n",
    ".code-reviews/issue-1/notes.md": "# notes\n"
  });

describe("verifyFinalization — argument validation", () => {
  it("rejects a non-positive issue number", () => {
    const result = verifyFinalization({
      root: process.cwd(),
      issue: 0,
      consensusSha: "a".repeat(40),
      finalSha: "b".repeat(40)
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid-commit" });
  });

  it("rejects a non-integer issue number", () => {
    expect(
      verifyFinalization({
        root: process.cwd(),
        issue: 1.5,
        consensusSha: "a".repeat(40),
        finalSha: "b".repeat(40)
      })
    ).toMatchObject({ ok: false, reason: "invalid-commit" });
  });

  it("rejects abbreviated or uppercase SHAs", () => {
    expect(
      verifyFinalization({ root: process.cwd(), issue: 1, consensusSha: "abc1234", finalSha: "b".repeat(40) })
    ).toMatchObject({ ok: false, reason: "invalid-commit" });

    expect(
      verifyFinalization({ root: process.cwd(), issue: 1, consensusSha: "A".repeat(40), finalSha: "b".repeat(40) })
    ).toMatchObject({ ok: false, reason: "invalid-commit" });
  });
});

describe("verifyFinalization — cleanup-only policy", () => {
  it("accepts deletion of this issue's coordination files", () => {
    const fixture = newFixture();
    const consensusSha = seedConsensus(fixture);
    const finalSha = fixture.remove("cleanup", [
      ".plans/issue-1/plan.md",
      ".plans/issue-1/review.md",
      ".signals/issue-1/joined-claude.json",
      ".code-reviews/issue-1/notes.md"
    ]);
    const result = verifyFinalization({ root: fixture.root, issue: 1, consensusSha, finalSha });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.deletedPaths).toEqual([
        ".code-reviews/issue-1/notes.md",
        ".plans/issue-1/plan.md",
        ".plans/issue-1/review.md",
        ".signals/issue-1/joined-claude.json"
      ]);
    }
  });

  it("accepts a final commit identical to consensus (nothing to clean up)", () => {
    const fixture = newFixture();
    const consensusSha = seedConsensus(fixture);
    const result = verifyFinalization({
      root: fixture.root,
      issue: 1,
      consensusSha,
      finalSha: consensusSha
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.deletedPaths).toEqual([]);
    }
  });

  it("rejects an added file", () => {
    const fixture = newFixture();
    const consensusSha = seedConsensus(fixture);
    const finalSha = fixture.commit("sneak in a file", { "src/extra.ts": "export const x = 1;\n" });
    const result = verifyFinalization({ root: fixture.root, issue: 1, consensusSha, finalSha });

    expect(result).toMatchObject({ ok: false, reason: "non-cleanup-change" });

    if (!result.ok) {
      expect(result.details).toContain("src/extra.ts");
    }
  });

  it("rejects a modified product file", () => {
    const fixture = newFixture();
    const consensusSha = seedConsensus(fixture);
    const finalSha = fixture.commit("modify product", { "src/feature.ts": "export const feature = 2;\n" });

    expect(verifyFinalization({ root: fixture.root, issue: 1, consensusSha, finalSha })).toMatchObject({
      ok: false,
      reason: "non-cleanup-change"
    });
  });

  it("rejects deleting a product file", () => {
    const fixture = newFixture();
    const consensusSha = seedConsensus(fixture);
    const finalSha = fixture.remove("delete product", ["src/feature.ts"]);

    expect(verifyFinalization({ root: fixture.root, issue: 1, consensusSha, finalSha })).toMatchObject({
      ok: false,
      reason: "non-cleanup-change"
    });
  });

  it("rejects deleting another issue's coordination files", () => {
    const fixture = newFixture();

    fixture.commit("other issue coordination", { ".plans/issue-2/plan.md": "# other\n" });

    const consensusSha = fixture.rev("HEAD");
    const finalSha = fixture.remove("cross-issue cleanup", [".plans/issue-2/plan.md"]);
    const result = verifyFinalization({ root: fixture.root, issue: 1, consensusSha, finalSha });

    expect(result).toMatchObject({ ok: false, reason: "non-cleanup-change" });

    if (!result.ok) {
      expect(result.details).toContain(".plans/issue-2/plan.md");
    }
  });

  it("rejects a rename even when both endpoints are cleanup-eligible", () => {
    const fixture = newFixture();
    const consensusSha = seedConsensus(fixture);

    fixture.git("mv", ".plans/issue-1/plan.md", ".plans/issue-1/plan-renamed.md");
    fixture.git("commit", "--quiet", "-m", "rename inside coordination");

    expect(
      verifyFinalization({ root: fixture.root, issue: 1, consensusSha, finalSha: fixture.rev("HEAD") })
    ).toMatchObject({ ok: false, reason: "non-cleanup-change" });
  });
});

describe("verifyFinalization — history requirements", () => {
  it("reports missing-consensus when the approved commit is absent", () => {
    const fixture = newFixture();
    const finalSha = seedConsensus(fixture);

    expect(
      verifyFinalization({ root: fixture.root, issue: 1, consensusSha: "0".repeat(40), finalSha })
    ).toMatchObject({ ok: false, reason: "missing-consensus" });
  });

  it("reports missing-final when the proposed head is absent", () => {
    const fixture = newFixture();
    const consensusSha = seedConsensus(fixture);

    expect(
      verifyFinalization({ root: fixture.root, issue: 1, consensusSha, finalSha: "0".repeat(40) })
    ).toMatchObject({ ok: false, reason: "missing-final" });
  });

  it("reports history-rewrite when the final commit is not a descendant", () => {
    const fixture = newFixture();
    const consensusSha = seedConsensus(fixture);

    fixture.git("checkout", "--quiet", "--orphan", "rewritten");
    fixture.git("rm", "-rf", "--quiet", ".");

    const finalSha = fixture.commit("rewritten history", { "src/feature.ts": "export const feature = 1;\n" });
    const result = verifyFinalization({ root: fixture.root, issue: 1, consensusSha, finalSha });

    expect(result).toMatchObject({ ok: false, reason: "history-rewrite" });

    if (!result.ok) {
      expect(result.details).toContain("may not replace or rewrite that history");
    }
  });
});
