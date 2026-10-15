import { fileURLToPath } from "node:url";
import { z } from "zod";
import { shellQuote } from "./agentHookSync.js";
import { localConfigGet } from "./gitExec.js";
import { githubRepositoryFromOrigin } from "./githubIssue.js";
import type { ProcessRunner } from "./runLoop.js";

export class GitHubAuthError extends Error {
  override readonly name = "GitHubAuthError";
}

export const GITHUB_HOST = "github.com";
export const githubLoginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
export const coordCliEntry = (): string => fileURLToPath(new URL("../dist/main.js", import.meta.url));
export const GITHUB_HELPER_KEY = "credential.https://github.com.helper";

export const gitCredentialHelperCommand = (account: string, cliEntry = coordCliEntry()): string =>
  `!/usr/bin/env node ${shellQuote(cliEntry)} auth git-credential --account ${githubLoginSchema.parse(account)}`;

export const gitCredentialArgs = (account: string, cliEntry = coordCliEntry()): string[] => [
  "-c", `${GITHUB_HELPER_KEY}=`, "-c", `${GITHUB_HELPER_KEY}=${gitCredentialHelperCommand(account, cliEntry)}`
];

export const withoutGitHubTokens = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env = { ...source };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[key];
  return env;
};

export const explainGitHubAuthFailure = (account: string, detail: string): string => {
  if (/401|bad credentials|expired|revoked|authentication failed|invalid username or (?:password|token)/i.test(detail)) {
    return `GitHub authentication for ${account} has expired or been revoked.\nRun: coord auth login`;
  }
  return `GitHub authentication for ${account} is unavailable.\nRun: coord auth login`;
};

export const resolveGitHubToken = async (
  account: string, runner: ProcessRunner, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env
): Promise<string> => {
  githubLoginSchema.parse(account);
  try {
    const result = await runner(["gh", "auth", "token", "--hostname", GITHUB_HOST, "--user", account], cwd,
      { env: withoutGitHubTokens(env) });
    const token = result.stdout.trim();
    if (result.exitCode !== 0 || token === "" || /\s/.test(token)) throw new GitHubAuthError("missing credential");
    return token;
  } catch {
    // gh diagnostics (and injected runner errors) can contain credential data.
    throw new GitHubAuthError(explainGitHubAuthFailure(account, ""));
  }
};

export const withGitHubAccount = (runner: ProcessRunner, account: string | null | undefined): ProcessRunner => {
  if (account == null) return runner;
  githubLoginSchema.parse(account);
  return async (argv, cwd, options) => {
    if (argv[0] === "git") return runner(["git", ...gitCredentialArgs(account), ...argv.slice(1)], cwd, options);
    if (argv[0] !== "gh") return runner(argv, cwd, options);
    const token = await resolveGitHubToken(account, runner, cwd, options?.env);
    let result;
    try {
      result = await runner(argv, cwd, { ...options, env: { ...withoutGitHubTokens(options?.env), GH_TOKEN: token } });
    } catch {
      throw new GitHubAuthError(`GitHub request for ${account} failed. Check connectivity and run coord auth status.`);
    }
    // Redact even if a command unexpectedly includes the supplied token in its diagnostics.
    const stderr = result.stderr.split(token).join("[redacted]");
    return { ...result, stdout: result.stdout.split(token).join("[redacted]"), stderr: result.exitCode !== 0 &&
      /401|bad credentials|expired|revoked|authentication failed/i.test(stderr)
      ? explainGitHubAuthFailure(account, stderr) : stderr };
  };
};

export const requireGitHubHttpsOrigin = (origin: string): string => {
  const repository = githubRepositoryFromOrigin(origin);
  if (!origin.startsWith("https://") || repository === null) {
    throw new GitHubAuthError("A selected GitHub account requires an https://[user@]github.com/owner/repo origin; SSH cannot enforce this account. Use --origin with an HTTPS URL.");
  }
  return repository;
};

export const verifyGitHubAccess = async (input: {
  account: string; origin: string; runner: ProcessRunner; cwd?: string; env?: NodeJS.ProcessEnv;
}): Promise<string> => {
  const repository = requireGitHubHttpsOrigin(input.origin);
  const runner = withGitHubAccount(input.runner, input.account);
  const cwd = input.cwd ?? process.cwd();
  const user = await runner(["gh", "api", "user", "--jq", ".login"], cwd, { env: input.env });
  if (user.exitCode !== 0) throw new GitHubAuthError(explainGitHubAuthFailure(input.account, user.stderr));
  if (user.stdout.trim().toLowerCase() !== input.account.toLowerCase()) {
    throw new GitHubAuthError(`GitHub credential does not identify the selected account ${input.account}.\nRun: coord auth login`);
  }
  const repo = await runner(["gh", "api", `repos/${repository}`, "--jq", ".full_name"], cwd, { env: input.env });
  if (repo.exitCode !== 0) {
    if (/401|bad credentials|expired|revoked/i.test(repo.stderr)) throw new GitHubAuthError(explainGitHubAuthFailure(input.account, repo.stderr));
    throw new GitHubAuthError(`GitHub account ${input.account} cannot access ${repository}. Check repository permissions.\nRun: coord auth login`);
  }
  return repository;
};

export const assertCloneGitHubWiring = (account: string | null | undefined, clones: readonly string[]): void => {
  for (const clone of clones) {
    if ((localConfigGet(clone, "coord.githubAccount") ?? null)?.toLowerCase() !== (account ?? null)?.toLowerCase()) {
      throw new GitHubAuthError(`GitHub account wiring in ${clone} differs from this issue's selection. Run coord install with the issue's --github-account before resuming.`);
    }
  }
};

export const gitCredentialResponse = async (input: {
  account: string; operation: string; request: string; runner: ProcessRunner; cwd?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  if (input.operation !== "get") return { stdout: "", stderr: "", exitCode: 0 };
  const fields = new Map(input.request.split(/\r?\n/).filter(Boolean).map((line) => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  if (fields.get("protocol") !== "https" || fields.get("host") !== GITHUB_HOST) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  try {
    const token = await resolveGitHubToken(input.account, input.runner, input.cwd);
    return { stdout: `username=${input.account}\npassword=${token}\n\n`, stderr: "", exitCode: 0 };
  } catch {
    return { stdout: "quit=1\n\n", stderr: `${explainGitHubAuthFailure(input.account, "")}\n`, exitCode: 0 };
  }
};

export const readGitHubAccounts = async (runner: ProcessRunner, cwd = process.cwd()): Promise<{
  accounts: string[]; active: string | null;
}> => {
  const result = await runner(["gh", "auth", "status", "--hostname", GITHUB_HOST, "--json", "hosts"], cwd,
    { env: withoutGitHubTokens() });
  // gh may return nonzero while still reporting accounts with invalid credentials.
  try {
    const data = z.object({ hosts: z.record(z.string(), z.array(z.object({
      login: githubLoginSchema, active: z.boolean().optional()
    }))) }).parse(JSON.parse(result.stdout));
    const entries = data.hosts[GITHUB_HOST] ?? [];
    return { accounts: [...new Set(entries.map((entry) => entry.login))], active: entries.find((entry) => entry.active)?.login ?? null };
  } catch {
    throw new GitHubAuthError("Cannot read GitHub accounts. Check gh auth status and update GitHub CLI before signing in.");
  }
};
