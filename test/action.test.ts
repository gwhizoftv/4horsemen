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
  approvedPaths: [],
  activeRoster: ["codex", "claude"],
  eligibleChoices: [],
  expectedSelectedAgents: [],
  contextPaths: [],
  changeScope: []
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
    expect(raw).not.toContain("## Repo context");
    expect(raw).not.toContain("## Changed paths for the bound pins");
    expect(raw).not.toContain("nudge");
    expect(raw).not.toContain("stepId:");
    expect(raw).not.toContain("evidence:");
    expect(raw).not.toContain("gate-");
  });

  it("renders Repo context and Changed paths sections when populated", () => {
    const ord = {
      ...order("/external/coord"),
      contextPaths: ["docs/repo-map.md", "docs/architecture.md"],
      changeScope: [
        {
          agent: "claude",
          commitSha: "3".repeat(40),
          paths: ["src/foo.ts", "src/bar.ts"],
          truncated: false
        },
        {
          agent: "cursor",
          commitSha: "4".repeat(40),
          paths: ["src/big.ts"],
          truncated: true
        }
      ]
    };
    const raw = renderAction(ord);
    expect(raw).toContain("## Repo context\n\n- `docs/repo-map.md`\n- `docs/architecture.md`");
    expect(raw).toContain("## Changed paths for the bound pins");
    expect(raw).toContain(`### claude (\`${"3".repeat(40)}\`)\n- \`src/foo.ts\`\n- \`src/bar.ts\``);
    expect(raw).toContain(`### cursor (\`${"4".repeat(40)}\`)\n- \`src/big.ts\`\n- ... (additional paths truncated)`);

    const parsed = parseAction(raw);
    expect(parsed.actionId).toBe("b2337d85-6617-4e9f-8ace-901453764aa4");
    expect(parsed.agent).toBe("codex");
    expect(parsed.body).toContain("## Repo context");
    expect(parsed.body).toContain("## Changed paths for the bound pins");
  });

  it("throws when contextPaths or changeScope paths contain backticks or newlines", () => {
    expect(() =>
      renderAction({
        ...order("/external/coord"),
        contextPaths: ["docs/`bad.md"]
      })
    ).toThrow("must not contain backticks");

    expect(() =>
      renderAction({
        ...order("/external/coord"),
        contextPaths: ["docs/bad\n.md"]
      })
    ).toThrow("must fit on one line");

    expect(() =>
      renderAction({
        ...order("/external/coord"),
        changeScope: [
          {
            agent: "claude",
            commitSha: "3".repeat(40),
            paths: ["src/`bad.ts"],
            truncated: false
          }
        ]
      })
    ).toThrow("must not contain backticks");

    expect(() =>
      renderAction({
        ...order("/external/coord"),
        changeScope: [
          {
            agent: "claude",
            commitSha: "3".repeat(40),
            paths: ["src/bad\n.ts"],
            truncated: false
          }
        ]
      })
    ).toThrow("must fit on one line");
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
