import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  actionFrontMatterKeys,
  clearCompletion,
  completionMessage,
  composeBody,
  mintActionId,
  parseActionMarkdown,
  parseCompletion,
  readCompletion,
  renderActionMarkdown,
  requiredPathFor,
  toRenderedAction,
  type Order
} from "../src/action.js";
import { stepById } from "../src/steps.js";

const roots: string[] = [];

const newRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "coord-action-"));

  roots.push(root);

  return root;
};

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();

    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const sha = (fill: string): string => fill.repeat(40).slice(0, 40);

const makeOrder = (overrides: Partial<Order> = {}): Order => ({
  actionId: "0123456789abcdef01234567",
  agent: "claude",
  stepId: "R3.plan-ballot",
  gateId: "gate-3-selection",
  evidenceId: "plan-ballot-published",
  requiredPath: ".plans/issue-1/ballot-claude.json",
  attempt: 1,
  round: null,
  inputs: [
    { agent: "codex", path: ".plans/issue-1/plan.md", commitSha: sha("b") },
    { agent: "cursor", path: ".plans/issue-1/plan.md", commitSha: sha("c") }
  ],
  outstanding: [],
  completePath: "/owner/coord/issue-1/agents/claude/complete",
  task: "File your plan ballot.",
  ...overrides
});

describe("mintActionId", () => {
  it("is opaque — it does not contain the step, gate, or phase", () => {
    const id = mintActionId("issue-1:abc", "claude", "R3.plan-ballot", 1, null);

    expect(id).toMatch(/^[a-f0-9]{24}$/);
    expect(id).not.toContain("R3");
    expect(id).not.toContain("plan");
    expect(id).not.toContain("gate");
    expect(id).not.toContain("claude");
  });

  it("is stable, so crash recovery re-mints the same id", () => {
    expect(mintActionId("issue-1:abc", "claude", "R2.plan", 1, null)).toBe(
      mintActionId("issue-1:abc", "claude", "R2.plan", 1, null)
    );
  });

  it("differs per agent, step, attempt, and round", () => {
    const base = mintActionId("issue-1:abc", "claude", "R2.plan", 1, null);

    expect(mintActionId("issue-1:abc", "codex", "R2.plan", 1, null)).not.toBe(base);
    expect(mintActionId("issue-1:abc", "claude", "R6.revise", 1, null)).not.toBe(base);
    expect(mintActionId("issue-1:abc", "claude", "R2.plan", 2, null)).not.toBe(base);
    expect(mintActionId("issue-1:abc", "claude", "R2.plan", 1, 2)).not.toBe(base);
  });
});

describe("rendered action confidentiality", () => {
  it("emits only the four permitted front matter keys", () => {
    const markdown = renderActionMarkdown(toRenderedAction(makeOrder()));
    const frontMatter = markdown.split("---")[1] ?? "";
    const keys = frontMatter
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(0, line.indexOf(":")).trim());

    expect(keys).toEqual([...actionFrontMatterKeys]);
  });

  it("never renders the step, gate, evidence id, round, or attempt", () => {
    const markdown = renderActionMarkdown(toRenderedAction(makeOrder({ attempt: 4, round: 2 })));

    expect(markdown).not.toContain("R3.plan-ballot");
    expect(markdown).not.toContain("gate-3-selection");
    expect(markdown).not.toContain("plan-ballot-published");
    expect(markdown).not.toContain("stepId");
    expect(markdown).not.toContain("gateId");
    expect(markdown).not.toContain("evidence");
    expect(markdown).not.toContain("attempt");
    expect(markdown).not.toMatch(/round/i);
  });

  it("names the required path and the absolute completion path", () => {
    const markdown = renderActionMarkdown(toRenderedAction(makeOrder()));

    expect(markdown).toContain(".plans/issue-1/ballot-claude.json");
    expect(markdown).toContain("/owner/coord/issue-1/agents/claude/complete");
  });

  it("does not expose peer status, only pinned peer inputs", () => {
    const markdown = renderActionMarkdown(toRenderedAction(makeOrder()));

    expect(markdown).toContain(sha("b"));
    expect(markdown).toContain(sha("c"));
    expect(markdown).not.toMatch(/waiting|denominator|roster|profile/i);
  });
});

describe("composeBody", () => {
  it("lists every bound input as an exact commit", () => {
    const body = composeBody(makeOrder());

    expect(body).toContain(`\`.plans/issue-1/plan.md\` from codex at commit ${sha("b")}`);
    expect(body).toContain(`\`.plans/issue-1/plan.md\` from cursor at commit ${sha("c")}`);
  });

  it("omits a dropped agent by simply listing fewer commits", () => {
    const withCodex = composeBody(makeOrder());
    const withoutCodex = composeBody(
      makeOrder({ inputs: [{ agent: "cursor", path: ".plans/issue-1/plan.md", commitSha: sha("c") }] })
    );

    expect(withCodex).toContain("codex");
    expect(withoutCodex).not.toContain("codex");
    // No announcement that anyone was removed.
    expect(withoutCodex).not.toMatch(/drop|removed|no longer/i);
  });

  it("includes concrete outstanding detail on a re-order", () => {
    const body = composeBody(
      makeOrder({ outstanding: ["missing required path .plans/issue-1/ballot-claude.json"] })
    );

    expect(body).toContain("did not satisfy this action");
    expect(body).toContain("missing required path .plans/issue-1/ballot-claude.json");
  });

  it("omits the inputs section entirely when there are none", () => {
    expect(composeBody(makeOrder({ inputs: [] }))).not.toContain("Read exactly these inputs");
  });

  it("states that pushing alone does not complete the action", () => {
    expect(composeBody(makeOrder())).toContain("Pushing alone does not complete this action");
  });
});

describe("parseActionMarkdown", () => {
  it("round trips a rendered action", () => {
    const rendered = toRenderedAction(makeOrder());
    const parsed = parseActionMarkdown(renderActionMarkdown(rendered));

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.value).toEqual(rendered);
    }
  });

  it("rejects an unknown front matter key", () => {
    const bad = ["---", "actionId: abc", "agent: claude", "stepId: R2.plan", "---", "", "body"].join("\n");
    const parsed = parseActionMarkdown(bad);

    expect(parsed.ok).toBe(false);

    if (!parsed.ok) {
      expect(parsed.error).toContain("stepId");
    }
  });

  it("rejects a missing front matter fence", () => {
    expect(parseActionMarkdown("no front matter here").ok).toBe(false);
  });

  it("rejects unclosed front matter", () => {
    expect(parseActionMarkdown("---\nactionId: abc\n").ok).toBe(false);
  });

  it("rejects a missing required key", () => {
    const bad = ["---", "actionId: abc", "agent: claude", "requiredPath: p", "---", "", "body"].join("\n");
    const parsed = parseActionMarkdown(bad);

    expect(parsed.ok).toBe(false);

    if (!parsed.ok) {
      expect(parsed.error).toContain("completePath");
    }
  });
});

describe("parseCompletion", () => {
  it("accepts a bare 40-hex SHA", () => {
    expect(parseCompletion(`${sha("a")}\n`)).toEqual({ ok: true, sha: sha("a") });
  });

  it("accepts a commit-prefixed SHA", () => {
    expect(parseCompletion(`commit ${sha("a")}\n`)).toEqual({ ok: true, sha: sha("a") });
  });

  it("tolerates surrounding whitespace and blank lines", () => {
    expect(parseCompletion(`\n   ${sha("a")}   \n\n`)).toEqual({ ok: true, sha: sha("a") });
  });

  it("rejects an empty file", () => {
    expect(parseCompletion("")).toEqual({ ok: false, reason: "empty" });
    expect(parseCompletion("\n \n")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects an abbreviated SHA", () => {
    expect(parseCompletion("4ab89257\n")).toEqual({ ok: false, reason: "abbreviated-sha" });
  });

  it("rejects an uppercase SHA", () => {
    expect(parseCompletion(`${sha("A")}\n`)).toEqual({ ok: false, reason: "uppercase-sha" });
  });

  it("rejects prose", () => {
    expect(parseCompletion("done!\n")).toEqual({ ok: false, reason: "not-a-sha" });
  });

  it("rejects JSON", () => {
    expect(parseCompletion(`{"sha":"${sha("a")}"}\n`)).toEqual({ ok: false, reason: "not-a-sha" });
  });

  it("rejects more than one line of content", () => {
    expect(parseCompletion(`${sha("a")}\n${sha("b")}\n`)).toEqual({ ok: false, reason: "multiple-lines" });
  });

  it("gives a concrete message for every failure reason", () => {
    for (const reason of ["absent", "empty", "not-a-sha", "multiple-lines", "abbreviated-sha", "uppercase-sha"] as const) {
      expect(completionMessage(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("completion file I/O", () => {
  it("reports absent when the file does not exist", () => {
    expect(readCompletion(join(newRoot(), "complete"))).toEqual({ ok: false, reason: "absent" });
  });

  it("reads a submitted SHA", () => {
    const path = join(newRoot(), "complete");

    writeFileSync(path, `${sha("d")}\n`);

    expect(readCompletion(path)).toEqual({ ok: true, sha: sha("d") });
  });

  it("clears an existing completion and is idempotent", () => {
    const path = join(newRoot(), "complete");

    writeFileSync(path, `${sha("d")}\n`);
    clearCompletion(path);

    expect(readCompletion(path)).toEqual({ ok: false, reason: "absent" });
    expect(() => clearCompletion(path)).not.toThrow();
  });
});

describe("requiredPathFor", () => {
  it("resolves issue and agent placeholders", () => {
    expect(requiredPathFor(stepById("R1.join"), 1, "claude")).toBe(".signals/issue-1/joined-claude.json");
    expect(requiredPathFor(stepById("R2.plan"), 42, "codex")).toBe(".plans/issue-42/plan.md");
  });

  it("refuses an agent id that is not a safe path segment", () => {
    expect(() => requiredPathFor(stepById("R1.join"), 1, "../etc")).toThrow(/valid path segment/);
  });
});
