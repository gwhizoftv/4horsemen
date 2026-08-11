import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAction, parseCompletion, readAction, renderAction, writeAction } from "../src/action.js";
import type { InternalOrder } from "../src/steps.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const order = (root: string): InternalOrder => ({
  actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
  issue: 1,
  agent: "codex",
  stepId: "R3.review",
  evidenceId: "review-published",
  requiredPath: ".plans/issue-1/review.md",
  completePath: join(root, "agents/codex/complete"),
  branch: "issue-1/codex",
  round: null,
  issueSessionId: `issue-1:${"1".repeat(40)}`,
  baselineSha: "1".repeat(40),
  automationDigest: "2".repeat(64),
  task: "Review the bound plan.",
  inputs: [{ agent: "claude", commitSha: "3".repeat(40), path: ".plans/issue-1/plan.md", kind: "plan" }],
  approvedPaths: []
});

describe("agent actions", () => {
  it("renders only the restricted public front matter and exact inputs", () => {
    const raw = renderAction(order("/external/coord"));
    const parsed = parseAction(raw);
    expect(parsed).toMatchObject({
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
      agent: "codex",
      requiredPath: ".plans/issue-1/review.md"
    });
    expect(raw).toContain("3".repeat(40));
    expect(raw).not.toContain("stepId:");
    expect(raw).not.toContain("evidence:");
    expect(raw).not.toContain("gate-");
  });

  it("round trips an atomically written action", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-action-"));
    roots.push(root);
    mkdirSync(join(root, "agents/codex"), { recursive: true });
    const path = join(root, "agents/codex/action.md");
    writeAction(root, path, order(root));
    expect(readAction(path).agent).toBe("codex");
    expect(readFileSync(path, "utf8")).toContain(join(root, "agents/codex/complete"));
  });

  it.each(["", "abc", `${"A".repeat(40)}\n`, ` ${"a".repeat(40)}`, `${"a".repeat(40)}\nextra\n`])(
    "rejects malformed completion %j",
    (raw) => expect(parseCompletion(raw).status).toBe("malformed")
  );

  it("accepts exactly one lowercase SHA with an optional final newline", () => {
    const sha = "a".repeat(40);
    expect(parseCompletion(sha)).toEqual({ status: "valid", sha });
    expect(parseCompletion(`${sha}\n`)).toEqual({ status: "valid", sha });
  });
});
