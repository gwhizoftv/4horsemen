import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * These files are never executed locally, so nothing else in the suite would
 * notice one that does not parse. GitHub's failure mode makes that worse than a
 * normal syntax error: a workflow it cannot read has no readable `on:` filter
 * either, so instead of staying dormant it starts a doomed run on **every**
 * push to **every** branch. `version-bump-on-merge.yml` shipped that way — an
 * unquoted `if:` whose expression contained `'chore: release '`, and the
 * `": "` inside it ended the YAML plain scalar — and it failed once per agent
 * push across three issue branches before anyone looked.
 */
const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

const workflowFiles = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

type Workflow = {
  on?: unknown;
  true?: unknown;
  concurrency?: { group?: string; queue?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<string, {
    if?: unknown;
    steps?: { id?: string; run?: string; env?: Record<string, string> }[];
  }>;
};

const parse = (name: string): Workflow => load(readFileSync(join(workflowsDir, name), "utf8")) as Workflow;

describe("GitHub workflow files", () => {
  it("has at least one workflow to check", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)("%s is valid YAML with jobs and steps", (name) => {
    const parsed = parse(name);
    expect(parsed).toBeTypeOf("object");
    const jobs = parsed.jobs ?? {};
    expect(Object.keys(jobs).length).toBeGreaterThan(0);
    for (const job of Object.values(jobs)) {
      expect(Array.isArray(job.steps)).toBe(true);
      expect((job.steps ?? []).length).toBeGreaterThan(0);
    }
  });

  it.each(workflowFiles)("%s keeps every `if:` expression quoted", (name) => {
    // The parse above already rejects an `if:` broken by a `": "`, but only when
    // the break happens to be fatal. Requiring the quotes outright removes the
    // question: an `if:` written as a bare `${{ … }}` is one edit away from
    // taking the whole file down, and the edit that does it looks harmless.
    for (const line of readFileSync(join(workflowsDir, name), "utf8").split("\n")) {
      const matched = /^\s*if:\s*(.*)$/.exec(line);
      if (matched === null) continue;
      const value = (matched[1] ?? "").trim();
      expect(value.startsWith('"') || value.startsWith("'")).toBe(true);
    }
  });
});

describe("version-bump-on-merge", () => {
  // Parsed inside each case, never in the describe body: a parse failure out
  // here aborts collection, and the run then reports "no tests" instead of
  // naming the file that broke.
  const triggersOf = (parsed: Workflow): { push?: { branches?: string[] } } =>
    // `on` is a YAML 1.1 boolean, so js-yaml keys the trigger block under `true`.
    (parsed.on ?? parsed.true) as { push?: { branches?: string[] } };

  it("triggers only on pushes to main", () => {
    const triggers = triggersOf(parse("version-bump-on-merge.yml"));
    // The bug this file shipped with made the workflow run on every push to
    // every branch. Asserting the filter is what proves it is readable at all.
    expect(triggers.push?.branches).toEqual(["main"]);
  });

  it("guards against re-running on its own release commit", () => {
    const guard = parse("version-bump-on-merge.yml").jobs?.bump?.if;
    expect(typeof guard).toBe("string");
    expect(guard).toContain("chore: release ");
    expect(guard).toContain("startsWith");
  });

  it("queues pending merges instead of replacing the previous pending run", () => {
    expect(parse("version-bump-on-merge.yml").concurrency).toEqual({
      group: "version-bump-on-merge",
      queue: "max",
      "cancel-in-progress": false
    });
  });

  it("pushes the release tag atomically with the bump commit", () => {
    const bump = parse("version-bump-on-merge.yml").jobs?.bump?.steps?.find((step) => step.id === "bump");
    expect(bump).toBeDefined();
    const script = bump?.run ?? "";
    const commit = 'git commit -m "chore: release ${version}"';
    const tag = 'git tag -f "v${version}"';
    const push = 'git push --atomic origin "HEAD:main" "refs/tags/v${version}"';
    expect(script).toContain(commit);
    expect(script).toContain(tag);
    expect(script).toContain(push);
    expect(script.indexOf(commit)).toBeLessThan(script.indexOf(tag));
    expect(script.indexOf(tag)).toBeLessThan(script.indexOf(push));
    // Outputs belong to the successful atomic push, never a rejected attempt.
    const lines = script.split("\n").map((line) => line.trim());
    const pushLine = lines.indexOf(`if ${push}; then`);
    expect(pushLine).toBeGreaterThanOrEqual(0);
    expect(lines[pushLine + 1]).toBe('echo "version=${version}" >> "$GITHUB_OUTPUT"');
    expect(script).toMatch(/echo "version=\$\{version\}" >> "\$GITHUB_OUTPUT"[\s\S]*?exit 0\s+fi/);
  });

  it("publishes a GitHub release for the pushed tag after the bump", () => {
    const workflow = parse("version-bump-on-merge.yml");
    const steps = workflow.jobs?.bump?.steps ?? [];
    const bumpIndex = steps.findIndex((step) => step.id === "bump");
    const releaseIndex = steps.findIndex((step) => step.run?.includes("gh release create"));
    expect(bumpIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(bumpIndex);
    const release = steps[releaseIndex];
    expect(release?.run?.trim()).toBe(
      'gh release create "v${VERSION}" --verify-tag --title "v${VERSION}" --generate-notes'
    );
    expect(release?.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      VERSION: "${{ steps.bump.outputs.version }}"
    });
    expect(release?.run).not.toContain("${{");
    expect(workflow.permissions?.contents).toBe("write");
  });
});
