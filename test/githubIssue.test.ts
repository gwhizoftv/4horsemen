import { describe, expect, it } from "vitest";
import {
  fetchGitHubIssueSnapshot,
  githubIssueRemediation,
  githubRepositoryFromOrigin,
  renderGitHubIssueSnapshot
} from "../src/githubIssue.js";
import { sha256 } from "../src/hash.js";

describe("githubIssue", () => {
  it("parses supported HTTPS and SSH origins", () => {
    expect(githubRepositoryFromOrigin("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("https://github.com/acme/app")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("git@github.com:acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("git@github.com:acme/app")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("/tmp/local.git")).toBeNull();
  });

  it("renders a stable canonical snapshot", () => {
    const bytes = renderGitHubIssueSnapshot({
      repository: "acme/app",
      number: 7,
      title: "Title",
      body: ""
    });
    expect(bytes).toBe(
      `${JSON.stringify({ repository: "acme/app", number: 7, title: "Title", body: "" }, null, 2)}\n`
    );
    expect(sha256(bytes)).toHaveLength(64);
  });

  it("fetches through an argv runner without a shell", async () => {
    const calls: string[][] = [];
    const { snapshot, bytes } = await fetchGitHubIssueSnapshot({
      origin: "https://github.com/acme/app.git",
      issue: 3,
      cwd: process.cwd(),
      runner: async (argv) => {
        calls.push([...argv]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ number: 3, title: "Hello", body: null }),
          stderr: ""
        };
      }
    });
    expect(calls[0]).toEqual(["gh", "issue", "view", "3", "--repo", "acme/app", "--json", "number,title,body"]);
    expect(snapshot).toEqual({ repository: "acme/app", number: 3, title: "Hello", body: "" });
    expect(bytes).toContain('"body": ""');
  });

  it("names create/auth remediation on failure", async () => {
    await expect(
      fetchGitHubIssueSnapshot({
        origin: "https://github.com/acme/app.git",
        issue: 9,
        cwd: process.cwd(),
        runner: async () => ({ exitCode: 1, stdout: "", stderr: "HTTP 401" })
      })
    ).rejects.toThrow(/gh auth|Create GitHub issue 9/);
    expect(githubIssueRemediation(9, "acme/app")).toContain("gh issue create");
  });

  it("rejects a mismatched issue number", async () => {
    await expect(
      fetchGitHubIssueSnapshot({
        origin: "https://github.com/acme/app.git",
        issue: 2,
        cwd: process.cwd(),
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ number: 99, title: "x", body: "y" }),
          stderr: ""
        })
      })
    ).rejects.toThrow(/expected 2/);
  });
});
