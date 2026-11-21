import { spawnSync } from "node:child_process";
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

/** Reselect beside the target CLI; retain this Node only as a validated fallback. */
export const coordNodeCommand = (cliEntry: string): string =>
  `${singleQuote(resolve(dirname(cliEntry), "..", "scripts", "lib", "node-runtime.sh"))} --fallback-node ${singleQuote(process.execPath)}`;

export const gitCredentialHelperCommand = (account: string, cliEntry: string): string =>
  `!${coordNodeCommand(cliEntry)} ${singleQuote(cliEntry)}${GITHUB_CREDENTIAL_HELPER_MARKER}${account}`;

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
const tokenLookupArgs = (account: string) => ["auth", "token", "--hostname", GITHUB_HOST, "--user", account];
const tokenFromResult = (account: string, code: number | null, stdout: string): string => {
  const token = stdout.trim();
  if (code !== 0 || token === "" || /\s/.test(token)) throw new GitHubAuthError(authUnavailableMessage(account));
  return token;
};

const selectedGhEnv = (token: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...withoutAmbientTokens(source), GH_TOKEN: token, GH_PROMPT_DISABLED: "1"
});

/** Read the named account's token from gh's credential storage; never the active account's. */
export const resolveGitHubToken = async (account: string, runner: ProcessRunner, cwd: string): Promise<string> => {
  let result;
  try {
    result = await runner(["gh", ...tokenLookupArgs(account)], cwd, {
      env: withoutAmbientTokens(),
      timeoutMs: TOKEN_LOOKUP_TIMEOUT_MS
    });
  } catch {
    throw new GitHubAuthError(authUnavailableMessage(account));
  }
  return tokenFromResult(account, result.exitCode, result.stdout);
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
        env: selectedGhEnv(token, options.env)
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

export const githubProfileSchema = z.object({
  login: githubLoginSchema,
  id: z.number().int().positive()
}).strict();
export type GitHubProfile = z.infer<typeof githubProfileSchema>;

export const AUTHOR_KEYS = ["user.name", "user.email"] as const;
type AuthorKey = typeof AUTHOR_KEYS[number];
export const AUTHOR_RECEIPT_KEY = "coord.managedGitAuthor";
export const gitAuthorSettings = ({ login, id }: GitHubProfile): [AuthorKey, string][] => [
  ["user.name", login],
  ["user.email", `${id}+${login}@users.noreply.github.com`]
];

const receiptSchema = z.partialRecord(z.enum(AUTHOR_KEYS), z.object({
  original: z.string().nullable(),
  installed: z.string()
}));

/** Record only keys coord changed. On unbind, restore those the owner hasn't edited. */
export const gitAuthorEdits = (profile: GitHubProfile | undefined, current: ReadonlyMap<string, string | null>): [string, string | null][] => {
  const saved = current.get(AUTHOR_RECEIPT_KEY);
  const receipt = saved ? receiptSchema.parse(JSON.parse(saved)) : {};
  const desired = new Map(profile ? gitAuthorSettings(profile) : []);
  const changes: [string, string | null][] = [];
  for (const key of AUTHOR_KEYS) {
    const value = current.get(key) ?? null;
    const target = desired.get(key);
    const previous = receipt[key];
    if (target !== undefined && target !== value) {
      receipt[key] = { original: previous ? previous.original : value, installed: target };
      changes.push([key, target]);
    } else if (target === undefined && previous) {
      if (value === previous.installed) changes.push([key, previous.original]);
      delete receipt[key];
    }
  }
  const record = Object.keys(receipt).length ? JSON.stringify(receipt) : null;
  if (record !== (saved ?? null)) {
    // Save provenance before installing, and forget it only after restoration.
    if (profile) changes.unshift([AUTHOR_RECEIPT_KEY, record]);
    else changes.push([AUTHOR_RECEIPT_KEY, record]);
  }
  return changes;
};

const profileArgs = ["api", "user", "--jq", "{login,id}"];
const detail = (result: { stdout: string; stderr: string; exitCode: number }): string =>
  result.stderr.trim().split("\n")[0] || result.stdout.trim() || `gh exited ${result.exitCode}`;

const authenticatedProfile = (account: string, result: { exitCode: number; stdout: string; stderr: string }): GitHubProfile => {
  if (result.exitCode !== 0) {
    if (isGitHubAuthFailure(`${result.stderr}\n${result.stdout}`)) throw new GitHubAuthError(authExpiredMessage(account));
    throw new GitHubAuthError(`Cannot verify GitHub account ${account}: ${detail(result)}`);
  }
  let profile: GitHubProfile;
  try {
    profile = githubProfileSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new GitHubAuthError(`Cannot verify GitHub account ${account}: expected a login and a positive numeric user ID.`);
  }
  if (profile.login.toLowerCase() !== account.toLowerCase()) {
    throw new GitHubAuthError(
      `The saved GitHub credential for ${account} authenticates as ${profile.login}.\nRun: coord auth login`
    );
  }
  return profile;
};

/** Direct synchronous installer callers have no CLI preflight to supply the profile. */
export const resolveInstallProfile = (account: string, cwd: string): GitHubProfile => {
  const options = { cwd, encoding: "utf8" as const, timeout: TOKEN_LOOKUP_TIMEOUT_MS };
  const lookup = spawnSync("gh", tokenLookupArgs(account), { ...options, env: withoutAmbientTokens() });
  const token = tokenFromResult(account, lookup.status, lookup.stdout ?? "");
  const user = spawnSync("gh", profileArgs, { ...options, env: selectedGhEnv(token) });
  return authenticatedProfile(account, {
    exitCode: user.status ?? 1, stdout: user.stdout ?? "", stderr: user.stderr || user.error?.message || ""
  });
};

export type GitHubAccess = { account: string; login: string; profile: GitHubProfile; repository: string };

/** The saved credential signs in as the account and can reach the repository. */
export const verifyGitHubAccess = async (input: {
  account: string;
  origin: string;
  runner: ProcessRunner;
  cwd: string;
}): Promise<GitHubAccess> => {
  const repository = requireHttpsGitHubOrigin(input.account, input.origin);
  const gh = withGitHubAccount(input.runner, input.account);
  const profile = authenticatedProfile(input.account, await gh(["gh", ...profileArgs], input.cwd, { timeoutMs: TOKEN_LOOKUP_TIMEOUT_MS }));
  const repo = await gh(["gh", "api", `repos/${repository}`, "--jq", ".full_name"], input.cwd);
  if (repo.exitCode !== 0) {
    if (isGitHubAuthFailure(`${repo.stderr}\n${repo.stdout}`)) throw new GitHubAuthError(authExpiredMessage(input.account));
    throw new GitHubAuthError(
      `GitHub account ${input.account} cannot access ${repository}: ${detail(repo)}. ` +
        "Grant that account access, or select another account with coord onboard <repository> --github-account <name>."
    );
  }
  return { account: input.account, login: profile.login, profile, repository };
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
