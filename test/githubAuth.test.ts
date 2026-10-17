import { afterEach, describe, expect, it } from "vitest";
import {
  gitCredentialResponse,
  verifyGitHubAccess,
  withGitHubAccount
} from "../src/githubAuth.js";
import type { ProcessOptions, ProcessResult } from "../src/runLoop.js";

type Call = { argv: readonly string[]; env: NodeJS.ProcessEnv | undefined };

/** Fake gh: `auth token --user acct` answers `token`, `api` answers from `api`. */
const fakeRunner = (input: {
  token?: string | null;
  api?: (argv: readonly string[]) => ProcessResult;
}) => {
  const calls: Call[] = [];
  const runner = async (argv: readonly string[], _cwd: string, options?: ProcessOptions): Promise<ProcessResult> => {
    calls.push({ argv, env: options?.env });
    if (argv[0] === "gh" && argv[1] === "auth" && argv[2] === "token") {
      return input.token === null || input.token === undefined
        ? { exitCode: 1, stdout: "", stderr: "no oauth token found for github.com account acct" }
        : { exitCode: 0, stdout: `${input.token}\n`, stderr: "" };
    }
    if (argv[0] === "gh" && argv[1] === "api" && input.api !== undefined) return input.api(argv);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  };
  return { runner, calls };
};

const ambient = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
afterEach(() => {
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GitHub account binding", () => {
  it("gives gh the named account's token and git the account helper, and leaves everything else alone", async () => {
    process.env.GH_TOKEN = "ambient-other-account";
    process.env.GITHUB_TOKEN = "ambient-other-account";
    const { runner, calls } = fakeRunner({ token: "tok-acct" });
    const bound = withGitHubAccount(runner, "acct", "/coord/dist/main.js");

    await bound(["gh", "issue", "view", "1"], "/work");
    const lookup = calls.find((call) => call.argv[2] === "token")!;
    expect(lookup.argv).toEqual(["gh", "auth", "token", "--hostname", "github.com", "--user", "acct"]);
    expect(lookup.env?.GH_TOKEN).toBeUndefined();
    expect(lookup.env?.GITHUB_TOKEN).toBeUndefined();
    const gh = calls.at(-1)!;
    expect(gh.argv).toEqual(["gh", "issue", "view", "1"]);
    expect(gh.env?.GH_TOKEN).toBe("tok-acct");
    expect(gh.env?.GITHUB_TOKEN).toBeUndefined();

    await bound(["git", "ls-remote", "origin"], "/work");
    const quotedNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    expect(calls.at(-1)!.argv).toEqual([
      "git",
      "-c", "credential.https://github.com.helper=",
      "-c", `credential.https://github.com.helper=!${quotedNode} '/coord/dist/main.js' auth git-credential --account acct`,
      "ls-remote", "origin"
    ]);

    const productEnv = { PATH: "/bin" };
    await bound(["pnpm", "check"], "/work", { env: productEnv });
    expect(calls.at(-1)).toEqual({ argv: ["pnpm", "check"], env: productEnv });

    expect(withGitHubAccount(runner, null)).toBe(runner);
  });

  it("refuses rather than running gh as another account when the saved token is unavailable", async () => {
    const { runner, calls } = fakeRunner({ token: null });
    await expect(withGitHubAccount(runner, "acct")(["gh", "pr", "list"], "/work")).rejects.toThrow(
      "GitHub authentication for acct is unavailable.\nRun: coord auth login"
    );
    expect(calls.some((call) => call.argv[1] === "pr")).toBe(false);
  });

  it("verifies the login and repository access with actionable failures", async () => {
    const verify = (api: (argv: readonly string[]) => ProcessResult) =>
      verifyGitHubAccess({ account: "acct", origin: "https://acct@github.com/acme/app.git", cwd: "/work",
        runner: fakeRunner({ token: "tok", api }).runner });
    const ok = { exitCode: 0, stderr: "" };

    await expect(verify((argv) => argv[2] === "user" ? { ...ok, stdout: "Acct\n" } : { ...ok, stdout: "acme/app\n" }))
      .resolves.toEqual({ account: "acct", login: "Acct", repository: "acme/app" });
    await expect(verify(() => ({ exitCode: 1, stdout: "", stderr: "HTTP 401: Bad credentials (https://api.github.com/user)" })))
      .rejects.toThrow("GitHub authentication for acct has expired or been revoked.\nRun: coord auth login");
    await expect(verify(() => ({ ...ok, stdout: "someone-else\n" })))
      .rejects.toThrow("The saved GitHub credential for acct authenticates as someone-else.\nRun: coord auth login");
    await expect(verify((argv) => argv[2] === "user" ? { ...ok, stdout: "acct\n" } : { exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found" }))
      .rejects.toThrow("GitHub account acct cannot access acme/app: HTTP 404: Not Found.");
    await expect(verifyGitHubAccess({ account: "acct", origin: "git@github.com:acme/app.git", cwd: "/work",
      runner: fakeRunner({ token: "tok" }).runner })).rejects.toThrow("needs an https://github.com/");
  });

  it("answers Git's credential protocol only for github.com https, and stops Git on failure", async () => {
    const request = "protocol=https\nhost=github.com\nusername=other\n";
    const answer = (operation: string, token: string | null, body = request) =>
      gitCredentialResponse({ operation, request: body, account: "acct", cwd: "/work", runner: fakeRunner({ token }).runner });

    expect(await answer("get", "tok")).toEqual({ stdout: "username=acct\npassword=tok\n", stderr: "" });
    expect(await answer("get", null)).toEqual({
      stdout: "quit=1\n",
      stderr: "GitHub authentication for acct is unavailable.\nRun: coord auth login\n"
    });
    expect(await answer("store", "tok")).toEqual({ stdout: "", stderr: "" });
    expect(await answer("erase", "tok")).toEqual({ stdout: "", stderr: "" });
    expect(await answer("get", "tok", "protocol=https\nhost=example.com\n")).toEqual({ stdout: "", stderr: "" });
  });
});
