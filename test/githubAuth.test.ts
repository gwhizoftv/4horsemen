import { describe, expect, it } from "vitest";
import {
  expiredAuthMessage,
  gitCredentialArgs,
  gitCredentialHelperCommand,
  gitCredentialResponse,
  unavailableAuthMessage,
  verifyGitHubAccess,
  withGitHubAccount,
  type AuthProcessRunner
} from "../src/githubAuth.js";

const recordingRunner = (
  handler: (argv: readonly string[], env?: NodeJS.ProcessEnv) => { exitCode: number; stdout: string; stderr: string }
): { runner: AuthProcessRunner; calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> } => {
  const calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    runner: async (argv, _cwd, options = {}) => {
      calls.push({ argv: [...argv], ...(options.env === undefined ? {} : { env: options.env }) });
      return handler(argv, options.env);
    }
  };
};

describe("githubAuth", () => {
  it("wraps gh with a named-user token and git with helper -c args", async () => {
    const { runner, calls } = recordingRunner((argv) => {
      if (argv[0] === "gh" && argv[1] === "auth" && argv[2] === "token") {
        expect(argv).toEqual(["gh", "auth", "token", "--hostname", "github.com", "--user", "acct"]);
        return { exitCode: 0, stdout: "tok-acct\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    });
    const wrapped = withGitHubAccount(runner, "acct", "/tmp/coord/dist/main.js");
    await wrapped(["gh", "issue", "view", "1"], "/tmp", { env: { GH_TOKEN: "ambient", PATH: "/bin" } });
    await wrapped(["git", "ls-remote", "origin"], "/tmp");
    await wrapped(["echo", "hi"], "/tmp", { env: { KEEP: "1" } });
    expect(calls[0]?.env?.GH_TOKEN).toBeUndefined();
    expect(calls[0]?.env?.GITHUB_TOKEN).toBeUndefined();
    expect(calls[1]?.env?.GH_TOKEN).toBe("tok-acct");
    expect(calls[2]?.argv[0]).toBe("git");
    expect(calls[2]?.argv[1]).toBe("-c");
    expect(calls[2]?.argv[2]).toBe("credential.https://github.com.helper=");
    expect(calls[2]?.argv[3]).toBe("-c");
    expect(calls[2]?.argv[4]).toContain("credential.https://github.com.helper=");
    expect(calls[2]?.argv.join(" ")).toContain("auth git-credential --account");
    expect(calls[3]?.argv).toEqual(["echo", "hi"]);
    expect(calls[3]?.env?.KEEP).toBe("1");
    expect(withGitHubAccount(runner, null)).toBe(runner);
  });

  it("refuses wrapped gh when the named token lookup fails", async () => {
    const { runner, calls } = recordingRunner((argv) => {
      if (argv[0] === "gh" && argv[1] === "auth") {
        return { exitCode: 1, stdout: "", stderr: "no token" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const wrapped = withGitHubAccount(runner, "acct", "/tmp/coord/dist/main.js");
    await expect(wrapped(["gh", "api", "user"], "/tmp")).rejects.toThrow(unavailableAuthMessage("acct"));
    expect(calls.every((call) => !(call.argv[0] === "gh" && call.argv[1] === "api"))).toBe(true);
  });

  it("verifyGitHubAccess maps 401, mismatch, and repo denial", async () => {
    const expired = recordingRunner((argv) => {
      if (argv.includes("token")) return { exitCode: 0, stdout: "tok\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "HTTP 401: Bad credentials" };
    });
    await expect(
      verifyGitHubAccess({ account: "acct", origin: "https://github.com/acme/app.git", runner: expired.runner })
    ).rejects.toThrow(expiredAuthMessage("acct"));

    const mismatch = recordingRunner((argv) => {
      if (argv.includes("token")) return { exitCode: 0, stdout: "tok\n", stderr: "" };
      if (argv.includes("user")) return { exitCode: 0, stdout: "other\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await expect(
      verifyGitHubAccess({ account: "acct", origin: "https://github.com/acme/app.git", runner: mismatch.runner })
    ).rejects.toThrow(/resolved as 'other'/);

    const denied = recordingRunner((argv) => {
      if (argv.includes("token")) return { exitCode: 0, stdout: "tok\n", stderr: "" };
      if (argv.includes("user")) return { exitCode: 0, stdout: "acct\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "HTTP 404" };
    });
    await expect(
      verifyGitHubAccess({ account: "acct", origin: "https://github.com/acme/app.git", runner: denied.runner })
    ).rejects.toThrow(/cannot access repository acme\/app/);
  });

  it("implements the git credential helper protocol", async () => {
    const ok = recordingRunner(() => ({ exitCode: 0, stdout: "secret\n", stderr: "" }));
    const filled = await gitCredentialResponse({
      account: "acct",
      operation: "get",
      stdin: "protocol=https\nhost=github.com\n\n",
      runner: ok.runner
    });
    expect(filled.stdout).toBe("username=acct\npassword=secret\n");

    const fail = recordingRunner(() => ({ exitCode: 1, stdout: "", stderr: "missing" }));
    const quit = await gitCredentialResponse({
      account: "acct",
      operation: "get",
      stdin: "protocol=https\nhost=github.com\n\n",
      runner: fail.runner
    });
    expect(quit.stdout).toBe("quit=1\n");
    expect(quit.stderr).toContain("unavailable");

    const store = await gitCredentialResponse({
      account: "acct",
      operation: "store",
      stdin: "protocol=https\nhost=github.com\n",
      runner: ok.runner
    });
    expect(store.stdout).toBe("");
    const other = await gitCredentialResponse({
      account: "acct",
      operation: "get",
      stdin: "protocol=https\nhost=example.com\n",
      runner: ok.runner
    });
    expect(other.stdout).toBe("");
    expect(gitCredentialArgs("acct", "/tmp/main.js")).toHaveLength(4);
    expect(gitCredentialHelperCommand("acct", "/tmp/main.js")).toContain("auth git-credential");
  });
});
