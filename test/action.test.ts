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
  submissionMode: "git",
  requiredPath: ".plans/issue-1/review.md",
  responsePath: null,
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
  it("renders scope approvals separately from the authorized product parent", () => {
    const base = order("/external/coord");
    const raw = renderAction({ ...base, stepId: "R6.revise", scopeInputs: [{
      agent: "codex", commitSha: "4".repeat(40), path: ".plans/issue-1/amendment-ballot-codex-1.json", kind: "amendment-approval"
    }] });
    expect(raw).toContain("## Approved file-map amendments");
    expect(raw).toContain("4".repeat(40));
    expect(raw).toContain("not product parents");
  });

  it("renders only the restricted public front matter and exact inputs", () => {
    const raw = renderAction(order("/external/coord"));
    const parsed = parseAction(raw);
    expect(parsed).toMatchObject({
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
      agent: "codex",
      submissionMode: "git",
      requiredPath: ".plans/issue-1/review.md"
    });
    expect(raw).toContain("submissionMode: git");
    expect(raw).not.toContain("responsePath:");
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
    // body the agent reads. Front matter stays the restricted public fields: a
    // completePath key there would become a parsed field agents could rely on.
    expect(body).toContain(join(root, "completes", "issue-1", "codex", "complete"));
    expect(frontMatter).not.toContain("complete");
    expect(frontMatter.split("\n").map((line) => line.split(":")[0])).toEqual([
      "actionId",
      "agent",
      "submissionMode",
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
    expect(parseCompletion(sha)).toEqual({ status: "valid", kind: "sha", sha });
    expect(parseCompletion(`${sha}\n`)).toEqual({ status: "valid", kind: "sha", sha });
    expect(parseCompletion(`commit ${sha}`)).toEqual({ status: "valid", kind: "sha", sha });
    expect(parseCompletion(`commit ${sha}\n`)).toEqual({ status: "valid", kind: "sha", sha });
  });

  it("renders and parses a response-mode ballot action", () => {
    const responsePath =
      "/external/coord/issue-1/agents/codex/responses/b2337d85-6617-4e9f-8ace-901453764aa4.json";
    const raw = renderAction({
      ...order("/external/coord"),
      stepId: "R3.plan-ballot",
      evidenceId: "plan-response-accepted",
      submissionMode: "response",
      requiredPath: "",
      responsePath,
      eligibleChoices: ["claude", "codex"],
      task: "Cast the plan ballot."
    });
    const parsed = parseAction(raw);
    expect(parsed).toEqual({
      submissionMode: "response",
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
      agent: "codex",
      responsePath,
      body: expect.any(String)
    });
    expect(raw).toContain("submissionMode: response");
    expect(raw).toContain(`responsePath: ${responsePath}`);
    expect(raw).toContain("response b2337d85-6617-4e9f-8ace-901453764aa4");
    expect(raw).not.toContain("requiredPath:");
  });

  it("rejects mixed git/response front matter and accepts response markers", () => {
    expect(() =>
      parseAction(`---
actionId: b2337d85-6617-4e9f-8ace-901453764aa4
agent: codex
submissionMode: response
responsePath: /runtime/responses/x.json
requiredPath: .plans/issue-1/ballot.json
---

body
`)
    ).toThrow(/requiredPath/);
    expect(() =>
      parseAction(`---
actionId: b2337d85-6617-4e9f-8ace-901453764aa4
agent: codex
requiredPath: .plans/issue-1/review.md
responsePath: /runtime/responses/x.json
---

body
`)
    ).toThrow(/responsePath/);
    const actionId = "b2337d85-6617-4e9f-8ace-901453764aa4";
    expect(parseCompletion(`response ${actionId}`)).toEqual({
      status: "valid",
      kind: "response",
      actionId
    });
    expect(parseCompletion(`response ${actionId}\n`)).toEqual({
      status: "valid",
      kind: "response",
      actionId
    });
    expect(parseCompletion("response not-a-uuid").status).toBe("malformed");
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

  it("omits the bound-file section when nothing was materialized", () => {
    const raw = renderAction(order("/external/coord"));
    expect(raw).not.toContain("## Bound input files");
    // An empty materialization is the same as none: the heading must not appear
    // with no paths under it.
    const empty = renderAction({
      ...order("/external/coord"),
      materialized: {
        inputSetHash: null,
        packetDir: null,
        manifestPath: null,
        entries: [],
        worktrees: [],
        omitted: ["plan from cursor: unreadable"]
      }
    });
    expect(empty).not.toContain("## Bound input files");
    // What could not be exported is an operator concern, not an instruction.
    expect(empty).not.toContain("unreadable");
  });

  it("lists materialized files and worktrees as absolute encoded paths", () => {
    const raw = renderAction({
      ...order("/external/coord"),
      materialized: {
        inputSetHash: "a".repeat(64),
        packetDir: `/external/coord/issue-1/inputs/${"a".repeat(64)}`,
        manifestPath: `/external/coord/issue-1/inputs/${"a".repeat(64)}/manifest.json`,
        entries: [
          {
            kind: "plan",
            agent: "cursor",
            commitSha: "6".repeat(40),
            path: ".plans/issue-1/plan.md",
            sha256: "b".repeat(64),
            localPath: `/external/coord/issue-1/inputs/${"a".repeat(64)}/plan-cursor-66666666/.plans/issue-1/plan.md`
          }
        ],
        worktrees: [
          {
            kind: "implementation",
            agent: "claude",
            commitSha: "7".repeat(40),
            localPath: "/external/coord/issue-1/worktrees/claude-77777777"
          }
        ],
        omitted: []
      }
    });
    expect(raw).toContain("## Bound input files");
    // A complete export says nothing about a fallback, which is what tells the
    // shim the pinned read is now redundant.
    expect(raw).not.toContain("Not every bound input could be exported");
    expect(raw).toContain(`plan from cursor (\`${"6".repeat(40)}\`)`);
    expect(raw).toContain('"/external/coord/issue-1/inputs/');
    expect(raw).toContain(`implementation worktree from claude (\`${"7".repeat(40)}\`)`);
    expect(raw).toContain('"/external/coord/issue-1/worktrees/claude-77777777"');
    expect(raw).toContain('"/external/coord/issue-1/inputs/aaaaaaaa');
    // The pins stay exactly where they were: the files say where bytes are, not
    // what is binding.
    expect(raw).toContain("Use these exact inputs");
    expect(parseAction(raw).agent).toBe("codex");
  });

  it("says so when only part of the bound set could be exported", () => {
    const raw = renderAction({
      ...order("/external/coord"),
      materialized: {
        inputSetHash: "a".repeat(64),
        packetDir: `/external/coord/issue-1/inputs/${"a".repeat(64)}`,
        manifestPath: `/external/coord/issue-1/inputs/${"a".repeat(64)}/manifest.json`,
        entries: [
          {
            kind: "plan",
            agent: "cursor",
            commitSha: "6".repeat(40),
            path: ".plans/issue-1/plan.md",
            sha256: "b".repeat(64),
            localPath: `/external/coord/issue-1/inputs/${"a".repeat(64)}/plan-cursor-66666666/.plans/issue-1/plan.md`
          }
        ],
        worktrees: [],
        omitted: ["plan from antigravity: 7777…:.plans/issue-1/plan.md is unreadable"]
      }
    });
    expect(raw).toContain("## Bound input files");
    // The shim greps for this line and keeps the pinned read open, so the input
    // that is missing from disk stays reachable through its pin.
    expect(raw).toContain("Not every bound input could be exported");
    // What failed is an operator concern; the action never names it.
    expect(raw).not.toContain("antigravity");
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
    const parsed = parseAction(raw);
    expect(parsed.submissionMode).not.toBe("response");
    if (parsed.submissionMode !== "response") {
      expect(parsed.requiredPath).toBe(".plans/issue-1/review.md");
    }
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
