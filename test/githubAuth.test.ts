import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCloneGitHubWiring, gitCredentialArgs, gitCredentialResponse, readGitHubAccounts, resolveGitHubToken,
  verifyGitHubAccess, withGitHubAccount } from "../src/githubAuth.js";
import type { ProcessRunner } from "../src/runLoop.js";

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
afterEach(() => vi.unstubAllEnvs());

describe("named GitHub credentials", () => {
  it("leaves unconfigured workspaces' missing-clone handling unchanged", () => {
    expect(() => assertCloneGitHubWiring(undefined, ["/missing-unconfigured-clone"])).not.toThrow();
  });
  it("isolates simultaneous accounts, refreshes tokens, and leaves product subprocess environments alone", async () => {
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) vi.stubEnv(key, "ambient-secret");
    let generation = 0;
    const calls: Parameters<ProcessRunner>[] = [];
    const runner: ProcessRunner = async (...args) => {
      calls.push(args);
      if (args[0][1] === "auth") return ok(`secret-${args[0].at(-1)}-${++generation}`);
      return ok();
    };
    const a = withGitHubAccount(runner, "account-a"), b = withGitHubAccount(runner, "account-b");
    expect(withGitHubAccount(runner, null)).toBe(runner);
    await Promise.all([a(["gh", "issue", "list"], "/tmp"), b(["gh", "pr", "list"], "/tmp")]);
    await a(["gh", "api", "user"], "/tmp");
    const tokens = calls.filter(([argv]) => argv[1] === "auth");
    expect(tokens).toHaveLength(3);
    for (const [argv, , options] of tokens) {
      expect(argv.slice(0, 6)).toEqual(["gh", "auth", "token", "--hostname", "github.com", "--user"]);
      for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) expect(options?.env?.[key]).toBeUndefined();
    }
    expect(calls.filter(([argv]) => argv[1] !== "auth").map(([, , options]) => options?.env?.GH_TOKEN))
      .toEqual(["secret-account-a-1", "secret-account-b-2", "secret-account-a-3"]);
    await a(["git", "fetch", "origin"], "/tmp");
    expect(calls.at(-1)?.[0]).toEqual(["git", ...gitCredentialArgs("account-a"), "fetch", "origin"]);
    const options = { env: { PRODUCT: "unchanged" }, timeoutMs: 12 };
    await a(["pnpm", "test"], "/tmp", options);
    expect(calls.at(-1)?.[2]).toBe(options);
  });

  it("fails closed without exposing lookup diagnostics or invoking the requested gh operation", async () => {
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({ exitCode: 1, stdout: "secret", stderr: "secret" });
    await expect(withGitHubAccount(runner, "acct")(["gh", "issue", "list"], "/tmp"))
      .rejects.toThrow("GitHub authentication for acct is unavailable.\nRun: coord auth login");
    expect(runner).toHaveBeenCalledTimes(1);
    runner.mockRejectedValue(new Error("secret"));
    await expect(resolveGitHubToken("acct", runner)).rejects.not.toThrow("secret");
  });

  it("verifies the actual login and repository access, distinguishes expired credentials, and refuses SSH", async () => {
    let user = ok("AcCt\n"), repo = ok("acme/app");
    const runner: ProcessRunner = async (argv) => argv[1] === "auth" ? ok("selected-secret") : argv[2] === "user" ? user : repo;
    const input = { account: "acct", origin: "https://other@github.com/acme/app.git", runner };
    expect(await verifyGitHubAccess(input)).toBe("acme/app");
    user = { exitCode: 1, stdout: "", stderr: "HTTP 401 Bad credentials selected-secret" };
    await expect(verifyGitHubAccess(input)).rejects.toThrow("GitHub authentication for acct has expired or been revoked.\nRun: coord auth login");
    user = ok("other-account");
    await expect(verifyGitHubAccess(input)).rejects.toThrow("does not identify the selected account acct");
    user = ok("acct"); repo = { exitCode: 1, stdout: "", stderr: "HTTP 404 selected-secret" };
    await expect(verifyGitHubAccess(input)).rejects.toThrow("cannot access acme/app");
    await expect(verifyGitHubAccess({ ...input, origin: "git@github.com:acme/app.git" })).rejects.toThrow("SSH");
  });

  it("implements read-only Git credential responses and stops fallback on lookup failure", async () => {
    const runner = vi.fn<ProcessRunner>().mockResolvedValue(ok("selected-secret"));
    const input = { account: "acct", operation: "get", request: "protocol=https\nhost=github.com\nusername=url-user\n\n", runner };
    expect(await gitCredentialResponse(input)).toEqual({ stdout: "username=acct\npassword=selected-secret\n\n", stderr: "", exitCode: 0 });
    runner.mockClear();
    for (const operation of ["store", "erase"]) expect((await gitCredentialResponse({ ...input, operation })).stdout).toBe("");
    expect((await gitCredentialResponse({ ...input, request: "protocol=https\nhost=example.com\n" })).stdout).toBe("");
    expect((await gitCredentialResponse({ ...input, request: "protocol=http\nhost=github.com\n" })).stdout).toBe("");
    expect(runner).not.toHaveBeenCalled();
    runner.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "secret" });
    expect(await gitCredentialResponse(input)).toEqual({ stdout: "quit=1\n\n", exitCode: 0,
      stderr: "GitHub authentication for acct is unavailable.\nRun: coord auth login\n" });
  });

  it("reads both active and inactive account choices from gh without ambient credentials", async () => {
    expect(await readGitHubAccounts(async () => ok(JSON.stringify({ hosts: { "github.com": [
      { login: "personal", active: true }, { login: "work", active: false }
    ] } })))).toEqual({ accounts: ["personal", "work"], active: "personal" });
  });
});
