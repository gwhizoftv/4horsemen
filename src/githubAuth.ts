import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { githubRepositoryFromOrigin } from "./githubIssue.js";
import type { ProcessRunner } from "./runLoop.js";

/**
 * Per-workspace GitHub account selection (#227).
 *
 * The workspace config names an account; its token always comes from gh's own
 * credential storage, looked up by that name on every use. Nothing here writes
 * a token anywhere, and nothing changes gh's shared active account: two
 * workspaces bound to different accounts can run at the same time.
 */

export const GITHUB_HOST = "github.com";

/** Clone-local key the generated launcher reads to export GH_TOKEN. */
export const GITHUB_ACCOUNT_KEY = "coord.githubAccount";

/** URL-scoped, so the helper never answers for another host. */
export const GITHUB_CREDENTIAL_HELPER_KEY = "credential.https://github.com.helper";

/** Identifies a helper value coord wrote; anything else belongs to the owner. */
export const GITHUB_CREDENTIAL_HELPER_MARKER = " auth git-credential --account ";

export const githubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "must be a GitHub login (letters, digits and hyphens)");

/** The installed CLI entry, resolved from this module in `src/` or `dist/`. */
export const coordCliEntry = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "main.js");

const singleQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const gitCredentialHelperCommand = (account: string, cliEntry: string): string =>
  `!${singleQuote(process.execPath)} ${singleQuote(cliEntry)}${GITHUB_CREDENTIAL_HELPER_MARKER}${account}`;

/**
 * One-shot Git settings: the empty value resets inherited helpers (osxkeychain,
 * a global `gh auth git-credential`), so only the selected account can answer.
 */
export const gitCredentialArgs = (account: string, cliEntry: string): string[] => [
  "-c", `${GITHUB_CREDENTIAL_HELPER_KEY}=`,
  "-c", `${GITHUB_CREDENTIAL_HELPER_KEY}=${gitCredentialHelperCommand(account, cliEntry)}`
];

/** Ambient tokens would answer for whichever account they belong to. */
const AMBIENT_TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

export const withoutAmbientTokens = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env = { ...source };
  for (const key of AMBIENT_TOKEN_VARIABLES) delete env[key];
  return env;
};

export class GitHubAuthError extends Error {
  override readonly name = "GitHubAuthError";
}

export const authUnavailableMessage = (account: string): string =>
  `GitHub authentication for ${account} is unavailable.\nRun: coord auth login`;

export const authExpiredMessage = (account: string): string =>
  `GitHub authentication for ${account} has expired or been revoked.\nRun: coord auth login`;

export const isGitHubAuthFailure = (text: string): boolean =>
  /HTTP 401|Bad credentials|Authentication failed|invalid username or (password|token)|requires authentication|could not read Username/i.test(text);

/** Append the actionable remedy to a gh or git failure caused by authentication. */
export const explainGitHubAuthFailure = (account: string, stderr: string): string =>
  isGitHubAuthFailure(stderr) ? `${stderr.trimEnd()}\n${authExpiredMessage(account)}` : stderr;

const TOKEN_LOOKUP_TIMEOUT_MS = 30_000;

/** Read the named account's token from gh's credential storage; never the active account's. */
export const resolveGitHubToken = async (account: string, runner: ProcessRunner, cwd: string): Promise<string> => {
  let result;
  try {
    result = await runner(["gh", "auth", "token", "--hostname", GITHUB_HOST, "--user", account], cwd, {
      env: withoutAmbientTokens(),
      timeoutMs: TOKEN_LOOKUP_TIMEOUT_MS
    });
  } catch {
    throw new GitHubAuthError(authUnavailableMessage(account));
  }
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || token === "" || /\s/.test(token)) throw new GitHubAuthError(authUnavailableMessage(account));
  return token;
};

/**
 * Bind gh and git subprocesses to the selected account. Only argv that starts
 * with `gh` or `git` changes; everything else, including product checks, is
 * passed through untouched. A null account returns the runner itself.
 */
export const withGitHubAccount = (
  runner: ProcessRunner,
  account: string | null | undefined,
  cliEntry: string = coordCliEntry()
): ProcessRunner => {
  if (account === null || account === undefined) return runner;
  return async (argv, cwd, options = {}) => {
    if (argv[0] === "gh") {
      const token = await resolveGitHubToken(account, runner, cwd);
      const result = await runner(argv, cwd, {
        ...options,
        env: { ...withoutAmbientTokens(options.env ?? process.env), GH_TOKEN: token, GH_PROMPT_DISABLED: "1" }
      });
      return result.exitCode === 0 ? result : { ...result, stderr: explainGitHubAuthFailure(account, result.stderr) };
    }
    if (argv[0] === "git") return runner(["git", ...gitCredentialArgs(account, cliEntry), ...argv.slice(1)], cwd, options);
    return runner(argv, cwd, options);
  };
};

/** The https origin form the credential helper covers. SSH would authenticate with another identity. */
export const requireHttpsGitHubOrigin = (account: string, origin: string): string => {
  const repository = githubRepositoryFromOrigin(origin);
  if (repository === null || !origin.startsWith("https://")) {
    throw new GitHubAuthError(
      `GitHub account ${account} needs an https://github.com/<owner>/<repository> origin; ${origin} is not one. ` +
        "Git over SSH authenticates with SSH keys, so the account selection could not be enforced."
    );
  }
  return repository;
};

export type GitHubAccess = { account: string; login: string; repository: string };

/** The saved credential signs in as the account and can reach the repository. */
export const verifyGitHubAccess = async (input: {
  account: string;
  origin: string;
  runner: ProcessRunner;
  cwd: string;
}): Promise<GitHubAccess> => {
  const repository = requireHttpsGitHubOrigin(input.account, input.origin);
  const gh = withGitHubAccount(input.runner, input.account);
  const detail = (result: { stdout: string; stderr: string; exitCode: number }): string =>
    result.stderr.trim().split("\n")[0] || result.stdout.trim() || `gh exited ${result.exitCode}`;

  const user = await gh(["gh", "api", "user", "--jq", ".login"], input.cwd);
  if (user.exitCode !== 0) {
    if (isGitHubAuthFailure(`${user.stderr}\n${user.stdout}`)) throw new GitHubAuthError(authExpiredMessage(input.account));
    throw new GitHubAuthError(`Cannot verify GitHub account ${input.account}: ${detail(user)}`);
  }
  const login = user.stdout.trim();
  if (login.toLowerCase() !== input.account.toLowerCase()) {
    throw new GitHubAuthError(
      `The saved GitHub credential for ${input.account} authenticates as ${login === "" ? "an unknown user" : login}.\n` +
        "Run: coord auth login"
    );
  }
  const repo = await gh(["gh", "api", `repos/${repository}`, "--jq", ".full_name"], input.cwd);
  if (repo.exitCode !== 0) {
    if (isGitHubAuthFailure(`${repo.stderr}\n${repo.stdout}`)) throw new GitHubAuthError(authExpiredMessage(input.account));
    throw new GitHubAuthError(
      `GitHub account ${input.account} cannot access ${repository}: ${detail(repo)}. ` +
        "Grant that account access, or select another account with coord onboard <repository> --github-account <name>."
    );
  }
  return { account: input.account, login, repository };
};

/**
 * Git credential-helper protocol for `coord auth git-credential`. Only `get`
 * answers; `store` and `erase` are ignored so a rejected token is never deleted
 * from gh's storage. A failed lookup answers `quit=1`, which stops Git from
 * consulting other helpers or prompting an unattended agent for a password.
 */
export const gitCredentialResponse = async (input: {
  operation: string;
  request: string;
  account: string;
  runner: ProcessRunner;
  cwd: string;
}): Promise<{ stdout: string; stderr: string }> => {
  if (input.operation !== "get") return { stdout: "", stderr: "" };
  const fields = new Map<string, string>();
  for (const line of input.request.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1));
  }
  if (fields.get("protocol") !== "https" || fields.get("host") !== GITHUB_HOST) return { stdout: "", stderr: "" };
  try {
    const token = await resolveGitHubToken(input.account, input.runner, input.cwd);
    return { stdout: `username=${input.account}\npassword=${token}\n`, stderr: "" };
  } catch (error) {
    return { stdout: "quit=1\n", stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
};

const accountStatusSchema = z.object({
  hosts: z.record(z.string(), z.array(z.object({ login: z.string(), active: z.boolean() }).passthrough()))
});

/** Accounts gh has saved for github.com, and which one is active. Never reads tokens. */
export const readGitHubAccounts = async (
  runner: ProcessRunner,
  cwd: string
): Promise<{ logins: string[]; active: string | null }> => {
  const result = await runner(["gh", "auth", "status", "--hostname", GITHUB_HOST, "--json", "hosts"], cwd, {
    env: withoutAmbientTokens()
  });
  if (result.exitCode !== 0) return { logins: [], active: null };
  let parsed;
  try {
    parsed = accountStatusSchema.safeParse(JSON.parse(result.stdout) as unknown);
  } catch {
    return { logins: [], active: null };
  }
  if (!parsed.success) return { logins: [], active: null };
  const accounts = parsed.data.hosts[GITHUB_HOST] ?? [];
  return {
    logins: accounts.map((account) => account.login),
    active: accounts.find((account) => account.active)?.login ?? null
  };
};
