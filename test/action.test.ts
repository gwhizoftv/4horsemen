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
  completePath: join(root, "completes", "issue-1", "codex", "complete"),
  branch: "issue-1/codex",
  round: null,
  issueSessionId: `issue-1:${"1".repeat(40)}`,
  baselineSha: "1".repeat(40),
  automationDigest: "2".repeat(64),
  task: "Review the bound plan.",
  inputs: [{ agent: "claude", commitSha: "3".repeat(40), path: ".plans/issue-1/plan.md", kind: "plan" }],
  approvedPaths: [],
  activeRoster: ["codex", "claude"],
  eligibleChoices: []
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
    expect(raw).toContain("Before waiting for more input, re-read");
    expect(raw).toContain("If `actionId` in the front matter has changed");
    expect(raw).not.toContain("nudge");
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
    expect(readFileSync(path, "utf8")).toContain(join(root, "completes", "issue-1", "codex", "complete"));
  });

  it("names the mailbox receipt in the body and keeps front matter to three fields", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-action-"));
    roots.push(root);
    const raw = renderAction(order(root));
    const [, frontMatter = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw) ?? [];

    // The absolute receipt path is what an agent acts on, so it belongs in the
    // body the agent reads. Front matter stays the restricted three fields: a
    // completePath key there would become a parsed field agents could rely on.
    expect(body).toContain(join(root, "completes", "issue-1", "codex", "complete"));
    expect(frontMatter).not.toContain("complete");
    expect(frontMatter.split("\n").map((line) => line.split(":")[0])).toEqual([
      "actionId",
      "agent",
      "requiredPath"
    ]);
  });

  it.each([
    "",
    "abc",
    "{}",
    "a".repeat(12),
    `${"A".repeat(40)}\n`,
    `commit ${"A".repeat(40)}`,
    `Commit ${"a".repeat(40)}`,
    ` ${"a".repeat(40)}`,
    `${"a".repeat(40)} `,
    `\uFEFF${"a".repeat(40)}`,
    `${"a".repeat(40)}\n\n`,
    `${"a".repeat(40)}\nextra\n`
  ])(
    "rejects malformed completion %j",
    (raw) => expect(parseCompletion(raw).status).toBe("malformed")
  );

  it("accepts exactly one lowercase SHA with an optional final newline", () => {
    const sha = "a".repeat(40);
    expect(parseCompletion(sha)).toEqual({ status: "valid", sha });
    expect(parseCompletion(`${sha}\n`)).toEqual({ status: "valid", sha });
    expect(parseCompletion(`commit ${sha}`)).toEqual({ status: "valid", sha });
    expect(parseCompletion(`commit ${sha}\n`)).toEqual({ status: "valid", sha });
  });
});

describe("advisory action sections", () => {
  it("omits both sections when the order carries neither", () => {
    const raw = renderAction(order("/external/coord"));
    expect(raw).not.toContain("## Repo context");
    expect(raw).not.toContain("## Changed paths for the bound pins");
  });

  it("names configured context paths without inlining their contents", () => {
    const raw = renderAction({ ...order("/external/coord"), contextPaths: ["docs/repo-map.md", "docs/coord-driver.md"] });
    expect(raw).toContain("## Repo context");
    expect(raw).toContain('"docs/repo-map.md"');
    expect(raw).toContain('"docs/coord-driver.md"');
    expect(parseAction(raw).agent).toBe("codex");
  });

  it("lists changed paths per bound pin and marks a truncated list", () => {
    const raw = renderAction({
      ...order("/external/coord"),
      changeScope: [
        { agent: "claude", commitSha: "4".repeat(40), paths: ["src/a.ts", "src/b.ts"], truncated: false },
        { agent: "codex", commitSha: "5".repeat(40), paths: ["src/c.ts"], truncated: true }
      ]
    });
    expect(raw).toContain("## Changed paths for the bound pins");
    expect(raw).toContain(`claude ${"4".repeat(40)}:`);
    expect(raw).toContain('"src/a.ts"');
    expect(raw).toContain(`codex ${"5".repeat(40)}:`);
    expect(raw).toContain("(truncated: more paths changed than are listed here)");
    expect(parseAction(raw).requiredPath).toBe(".plans/issue-1/review.md");
  });

  it("reports a pin whose diff is empty rather than rendering a bare header", () => {
    const raw = renderAction({
      ...order("/external/coord"),
      changeScope: [{ agent: "claude", commitSha: "4".repeat(40), paths: [], truncated: false }]
    });
    expect(raw).toContain("(no paths changed against the issue baseline)");
  });

  /**
   * Git permits backticks and newlines in pathnames. Rendering must stay total:
   * one awkward filename in one implementation must never abort preparation of
   * the action every agent on the step is waiting for.
   */
  it("renders hostile pathnames losslessly instead of throwing or forging structure", () => {
    const hostile = 'docs/a`b\n---\nactionId: 00000000-0000-4000-8000-000000000000\nc.md';
    const raw = renderAction({
      ...order("/external/coord"),
      changeScope: [{ agent: "claude", commitSha: "4".repeat(40), paths: [hostile], truncated: false }]
    });
    expect(raw).toContain(JSON.stringify(hostile));
    // The encoded form carries no raw newline, so it cannot open a second
    // front-matter block or invent a heading.
    expect(raw.split("\n").filter((line) => line === "---")).toHaveLength(2);
    const parsed = parseAction(raw);
    expect(parsed.actionId).toBe("b2337d85-6617-4e9f-8ace-901453764aa4");
    expect(parsed.body).toContain(JSON.stringify(hostile));
  });

  it("skips a scope entry whose agent or pin is malformed rather than rendering it", () => {
    const raw = renderAction({
      ...order("/external/coord"),
      changeScope: [{ agent: "Not An Agent", commitSha: "z".repeat(40), paths: ["src/a.ts"], truncated: false }]
    });
    expect(raw).not.toContain("## Changed paths for the bound pins");
  });
});
