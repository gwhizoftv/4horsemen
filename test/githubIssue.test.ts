import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchGitHubIssue,
  formatFinalizationPullRequest,
  githubRepositoryFromOrigin,
  readGitHubIssueSnapshot,
  renderGitHubIssueSnapshot
} from "../src/githubIssue.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub issue snapshots", () => {
  it("derives supported repositories and binds lookup to origin rather than cwd", async () => {
    expect(githubRepositoryFromOrigin("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("git@github.com:acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("/tmp/app.git")).toBeNull();
    const calls: string[][] = [];
    const snapshot = await fetchGitHubIssue({
      origin: "https://github.com/acme/app.git",
      issue: 42,
      cwd: "/unrelated/repository",
      runner: async (argv) => {
        calls.push([...argv]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 42,
            title: "Work",
            body: "Do it",
            url: "https://github.com/acme/app/issues/42"
          }),
          stderr: ""
        };
      }
    });
    expect(calls[0]).toEqual([
      "gh",
      "issue",
      "view",
      "42",
      "--repo",
      "acme/app",
      "--json",
      "number,title,body,url"
    ]);
    expect(snapshot.repository).toBe("acme/app");
    expect(renderGitHubIssueSnapshot(snapshot)).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
  });

  it("fails with issue-first remediation on a missing or unreadable issue", async () => {
    await expect(
      fetchGitHubIssue({
        origin: "https://github.com/acme/app.git",
        issue: 999,
        cwd: "/tmp",
        runner: async () => ({ exitCode: 1, stdout: "", stderr: "issue not found" })
      })
    ).rejects.toThrow(/Create GitHub issue 999.*gh auth status/);
  });

  it("rejects malformed and mismatched responses", async () => {
    const input = {
      origin: "https://github.com/acme/app.git",
      issue: 7,
      cwd: "/tmp"
    };
    await expect(
      fetchGitHubIssue({ ...input, runner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }) })
    ).rejects.toThrow(/invalid snapshot/);
    await expect(
      fetchGitHubIssue({
        ...input,
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            number: 8,
            title: "wrong",
            body: "",
            url: "https://github.com/acme/app/issues/8"
          }),
          stderr: ""
        })
      })
    ).rejects.toThrow(/issue 8 while issue 7/);
  });

  it("normalizes an empty GitHub issue body to an empty string", async () => {
    const snapshot = await fetchGitHubIssue({
      origin: "https://github.com/acme/app.git",
      issue: 3,
      cwd: "/tmp",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          number: 3,
          title: "Body optional",
          body: null,
          url: "https://github.com/acme/app/issues/3"
        }),
        stderr: ""
      })
    });
    expect(snapshot.body).toBe("");
  });

  it("reads a durable runtime snapshot and formats finalization PR text", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-issue-snap-"));
    roots.push(root);
    const path = join(root, "github-issue.json");
    const snapshot = {
      repository: "acme/app",
      number: 112,
      title: "Have PR's include the issue title",
      body: "Close on merge.",
      url: "https://github.com/acme/app/issues/112"
    };
    writeFileSync(path, renderGitHubIssueSnapshot(snapshot));
    expect(readGitHubIssueSnapshot(path)).toEqual(snapshot);
    expect(
      formatFinalizationPullRequest({
        issue: 112,
        title: snapshot.title,
        finalSha: "a".repeat(40),
        draft: true
      })
    ).toEqual({
      title: "Issue 112: Have PR's include the issue title",
      body: `Closes #112\n\nDraft PR for issue 112. Owner merges. Final pin: ${"a".repeat(40)}.`
    });
    expect(
      formatFinalizationPullRequest({
        issue: 112,
        title: "  ",
        finalSha: "b".repeat(40),
        draft: false
      }).title
    ).toBe("Issue 112: coordinated implementation");
  });
});

describe("evidence provenance in the pull request body", () => {
  it("names the branch and tip and refuses to call it an agent signature", () => {
    const pr = formatFinalizationPullRequest({
      issue: 110,
      title: "Submit ballots through private runtime",
      finalSha: "f".repeat(40),
      draft: true,
      evidenceBranch: "issue-110/coordinator-evidence",
      evidenceTip: "e".repeat(40)
    });
    expect(pr.body).toContain("issue-110/coordinator-evidence");
    expect(pr.body).toContain("e".repeat(40));
    // The qualification is the point: a reader who took the commit for a
    // cryptographic agent signature would over-trust it.
    expect(pr.body).toContain("not a");
    expect(pr.body).toContain("cryptographic agent signature");
    expect(pr.body).toContain("not merged into this PR");
    // The product PR still points only at the deletion-clean final pin.
    expect(pr.body).toContain(`Final pin: ${"f".repeat(40)}`);
  });

  it("omits the evidence section entirely when nothing was published", () => {
    const pr = formatFinalizationPullRequest({
      issue: 110,
      title: "Anything",
      finalSha: "f".repeat(40),
      draft: false
    });
    expect(pr.body).not.toContain("Ballot evidence");
    expect(pr.body).toContain("Closes #110");
  });
});
