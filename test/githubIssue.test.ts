import { describe, expect, it } from "vitest";
import { fetchGitHubIssue, githubRepositoryFromOrigin, renderGitHubIssueSnapshot } from "../src/githubIssue.js";

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
});
