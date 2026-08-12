import { describe, expect, it } from "vitest";
import { sha256 } from "../src/hash.js";
import {
  canonicalIssueSnapshot,
  fetchIssueSnapshot,
  githubRepositoryFromOrigin,
  IssueFetchError,
  type ProcessResult
} from "../src/githubIssue.js";

const ok = (body: unknown): ProcessResult => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: "" });

const capture = (): { argv: string[][]; runner: (argv: readonly string[]) => Promise<ProcessResult> } => {
  const argv: string[][] = [];
  return {
    argv,
    runner: async (received) => {
      argv.push([...received]);
      return ok({
        number: Number(received[3]),
        title: "Simplify bootstrap",
        body: "The owner flow should be three commands.",
        url: `https://github.com/acme/app/issues/${received[3] ?? "0"}`
      });
    }
  };
};

const fetchWith = async (
  runner: (argv: readonly string[]) => Promise<ProcessResult>,
  overrides: { origin?: string; issue?: number } = {}
) =>
  fetchIssueSnapshot({
    origin: overrides.origin ?? "https://github.com/acme/app",
    issue: overrides.issue ?? 42,
    runner,
    cwd: "/tmp"
  });

describe("githubRepositoryFromOrigin", () => {
  it("accepts the origin forms git itself writes", () => {
    expect(githubRepositoryFromOrigin("https://github.com/acme/app")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("https://github.com/acme/app/")).toBe("acme/app");
    expect(githubRepositoryFromOrigin("git@github.com:acme/app.git")).toBe("acme/app");
  });

  it("rejects anything that is not a github.com repository", () => {
    expect(githubRepositoryFromOrigin("/srv/git/app.git")).toBeNull();
    expect(githubRepositoryFromOrigin("https://gitlab.com/acme/app")).toBeNull();
    expect(githubRepositoryFromOrigin("https://github.com/acme")).toBeNull();
  });
});

describe("fetchIssueSnapshot", () => {
  it("asks the repository the config names, never the process working directory", async () => {
    const { argv, runner } = capture();
    await fetchWith(runner);
    // `coord 42 --product /path/to/A` run from inside product B must hash A's
    // issue 42. Without an explicit --repo, gh would resolve from the cwd.
    expect(argv[0]).toEqual(["gh", "issue", "view", "42", "--repo", "acme/app", "--json", "number,title,body,url"]);
  });

  it("names the create remedy when the issue does not exist", async () => {
    const runner = async (): Promise<ProcessResult> => ({
      exitCode: 1,
      stdout: "",
      stderr: "GraphQL: Could not resolve to an Issue with the number of 42."
    });
    await expect(fetchWith(runner)).rejects.toThrow(/gh issue create --repo acme\/app/);
    await expect(fetchWith(runner)).rejects.toBeInstanceOf(IssueFetchError);
  });

  it("names the auth remedy alongside it, because both produce a failed gh", async () => {
    const runner = async (): Promise<ProcessResult> => ({ exitCode: 4, stdout: "", stderr: "gh: authentication required" });
    await expect(fetchWith(runner)).rejects.toThrow(/gh auth status/);
  });

  it("explains a non-GitHub origin instead of running gh at all", async () => {
    let called = false;
    const runner = async (): Promise<ProcessResult> => {
      called = true;
      return ok({});
    };
    await expect(fetchWith(runner, { origin: "/srv/git/app.git" })).rejects.toThrow(/not a github.com repository/);
    expect(called).toBe(false);
  });

  it("says so when gh cannot be run at all", async () => {
    const runner = async (): Promise<ProcessResult> => {
      throw new Error("spawn gh ENOENT");
    };
    await expect(fetchWith(runner)).rejects.toThrow(/Install the GitHub CLI/);
  });

  it("refuses an answer about a different issue", async () => {
    const runner = async (): Promise<ProcessResult> =>
      ok({ number: 7, title: "t", body: "b", url: "https://github.com/acme/app/issues/7" });
    await expect(fetchWith(runner, { issue: 42 })).rejects.toThrow(/returned issue 7/);
  });

  it("refuses output that is not the shape gh documents", async () => {
    await expect(fetchWith(async () => ({ exitCode: 0, stdout: "not json", stderr: "" }))).rejects.toThrow(/not JSON/);
    await expect(fetchWith(async () => ok({ number: 42 }))).rejects.toThrow(/unexpected issue shape/);
  });

  it("treats an empty body as empty text rather than as missing", async () => {
    const snapshot = await fetchWith(async () =>
      ok({ number: 42, title: "t", body: null, url: "https://github.com/acme/app/issues/42" })
    );
    expect(snapshot.body).toBe("");
  });
});

describe("canonicalIssueSnapshot", () => {
  const snapshot = {
    repository: "acme/app",
    number: 42,
    title: "Simplify bootstrap",
    body: "line one\nline two\n",
    url: "https://github.com/acme/app/issues/42"
  };

  it("is stable regardless of the key order it was built with", () => {
    const shuffled = {
      url: snapshot.url,
      body: snapshot.body,
      number: snapshot.number,
      title: snapshot.title,
      repository: snapshot.repository
    };
    expect(canonicalIssueSnapshot(shuffled)).toBe(canonicalIssueSnapshot(snapshot));
  });

  it("carries no fetch timestamp, so re-hashing the persisted file reproduces the digest", () => {
    const first = canonicalIssueSnapshot(snapshot);
    const second = canonicalIssueSnapshot(snapshot);
    expect(sha256(first)).toBe(sha256(second));
    expect(first).not.toMatch(/fetchedAt|[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  });

  it("changes when the work statement changes", () => {
    const retitled = sha256(canonicalIssueSnapshot({ ...snapshot, title: "Something else" }));
    const rewritten = sha256(canonicalIssueSnapshot({ ...snapshot, body: "different" }));
    const original = sha256(canonicalIssueSnapshot(snapshot));
    expect(new Set([original, retitled, rewritten]).size).toBe(3);
  });
});
