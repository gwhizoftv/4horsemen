import { z } from "zod";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localConfigGet } from "./gitExec.js";
import { githubRepositoryFromOrigin } from "./githubIssue.js";

export const GITHUB_HOST = "github.com";
export const GITHUB_ACCOUNT_KEY = "coord.githubAccount";
export const CREDENTIAL_HELPER_KEY = `credential.https://${GITHUB_HOST}.helper`;
/** Marks helper values owned by coord so uninstall can remove only those. */
export const CREDENTIAL_HELPER_MARKER = "auth git-credential";

/** Local copy — avoid importing agentHookSync (it pulls state and would cycle). */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const githubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "github.account must be a GitHub login");

const TOKEN_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN"
] as const;

export type AuthProcessResult = { exitCode: number; stdout: string; stderr: string };
export type AuthProcessRunner = (
  argv: readonly string[],
  cwd: string,
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<AuthProcessResult>;

export const unavailableAuthMessage = (account: string): string =>
  `GitHub authentication for ${account} is unavailable.\nRun: coord auth login`;

export const expiredAuthMessage = (account: string): string =>
  `GitHub authentication for ${account} has expired or been revoked.\nRun: coord auth login`;

export const stripAmbientGitHubTokens = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of TOKEN_ENV_KEYS) delete env[key];
  return env;
};

/** `dist/main.js` next to this package, matching the install-recorded cliEntry. */
export const coordCliEntry = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "main.js");

export const gitCredentialHelperCommand = (account: string, cliEntry: string): string =>
  `!/usr/bin/env node ${shellQuote(resolve(cliEntry))} auth git-credential --account ${shellQuote(account)}`;

/** `-c` pairs that reset inherited helpers then install the account-keyed helper. */
export const gitCredentialArgs = (account: string, cliEntry: string): readonly string[] => [
  "-c",
  `${CREDENTIAL_HELPER_KEY}=`,
  "-c",
  `${CREDENTIAL_HELPER_KEY}=${gitCredentialHelperCommand(account, cliEntry)}`
];

export const assertHttpsOriginForAccount = (origin: string, account: string): void => {
  if (!/^https:\/\//i.test(origin) || githubRepositoryFromOrigin(origin) === null) {
    throw new Error(
      `GitHub account '${account}' requires an https://github.com/<owner>/<repo> origin so the selection can be enforced; got '${origin}'.`
    );
  }
};

export const resolveGitHubToken = async (
  account: string,
  runner: AuthProcessRunner,
  cwd = process.cwd()
): Promise<string> => {
  const result = await runner(
    ["gh", "auth", "token", "--hostname", GITHUB_HOST, "--user", account],
    cwd,
    { env: stripAmbientGitHubTokens() }
  );
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || token === "") {
    throw new Error(unavailableAuthMessage(account));
  }
  return token;
};

const isExpiredAuthOutput = (text: string): boolean =>
  /401|bad credentials|authentication required|token.*revoked|token.*expired/i.test(text);

export const explainGitHubAuthFailure = (account: string, stderr: string): string | null => {
  if (isExpiredAuthOutput(stderr)) return expiredAuthMessage(account);
  if (/could not read username|terminal prompts disabled|authentication failed|fatal:.*auth/i.test(stderr)) {
    return unavailableAuthMessage(account);
  }
  return null;
};

export const withGitHubAccount = (
  runner: AuthProcessRunner,
  account: string | null | undefined,
  cliEntry: string = coordCliEntry()
): AuthProcessRunner => {
  if (account === null || account === undefined || account === "") return runner;
  const authArgs = gitCredentialArgs(account, cliEntry);
  return async (argv, cwd, options = {}) => {
    const [command, ...rest] = argv;
    if (command === "git") {
      return runner(["git", ...authArgs, ...rest], cwd, options);
    }
    if (command === "gh") {
      const token = await resolveGitHubToken(account, runner, cwd);
      const env = { ...stripAmbientGitHubTokens(options.env ?? process.env), GH_TOKEN: token };
      return runner(argv, cwd, { ...options, env });
    }
    return runner(argv, cwd, options);
  };
};

export const verifyGitHubAccess = async (input: {
  account: string;
  origin: string;
  runner: AuthProcessRunner;
  cwd?: string;
}): Promise<void> => {
  const cwd = input.cwd ?? process.cwd();
  const token = await resolveGitHubToken(input.account, input.runner, cwd);
  const env = { ...stripAmbientGitHubTokens(), GH_TOKEN: token };
  const user = await input.runner(["gh", "api", "user", "--jq", ".login"], cwd, { env });
  const userText = `${user.stderr}\n${user.stdout}`;
  if (user.exitCode !== 0) {
    throw new Error(isExpiredAuthOutput(userText) ? expiredAuthMessage(input.account) : unavailableAuthMessage(input.account));
  }
  const login = user.stdout.trim();
  if (login.toLowerCase() !== input.account.toLowerCase()) {
    throw new Error(
      `GitHub authentication for ${input.account} resolved as '${login}', not the selected account.\nRun: coord auth login`
    );
  }
  const repository = githubRepositoryFromOrigin(input.origin);
  if (repository === null) {
    throw new Error(
      `Cannot verify GitHub access for ${input.account}: origin ${input.origin} is not a supported github.com repository.`
    );
  }
  const repo = await input.runner(["gh", "api", `repos/${repository}`, "--jq", ".full_name"], cwd, { env });
  const repoText = `${repo.stderr}\n${repo.stdout}`;
  if (repo.exitCode !== 0) {
    if (isExpiredAuthOutput(repoText)) throw new Error(expiredAuthMessage(input.account));
    throw new Error(
      `GitHub account '${input.account}' cannot access repository ${repository}.\nRun: coord auth login`
    );
  }
};

export const assertCloneGitHubWiring = (account: string, clones: readonly string[]): void => {
  for (const clone of clones) {
    const value = localConfigGet(clone, GITHUB_ACCOUNT_KEY);
    if (value !== account) {
      throw new Error(
        `Clone ${clone} has ${GITHUB_ACCOUNT_KEY}=${value ?? "<unset>"}, expected ${account}.\n` +
          "Run: coord onboard <product>"
      );
    }
  }
};

export type GitHubAccountListing = { logins: string[]; active: string | null };

export const readGitHubAccounts = async (
  runner: AuthProcessRunner,
  cwd = process.cwd()
): Promise<GitHubAccountListing> => {
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await runner(
      ["gh", "auth", "status", "--hostname", GITHUB_HOST, "--json", "hosts"],
      cwd,
      { env: stripAmbientGitHubTokens() }
    );
  } catch {
    // Missing gh (ENOENT) or other spawn failure: treat as no known logins.
    return { logins: [], active: null };
  }
  if (result.exitCode !== 0) return { logins: [], active: null };
  try {
    const parsed = JSON.parse(result.stdout) as { hosts?: Record<string, Array<{ login?: string; active?: boolean }>> };
    const rows = parsed.hosts?.[GITHUB_HOST] ?? [];
    const logins = rows.map((row) => row.login).filter((login): login is string => typeof login === "string" && login !== "");
    const active = rows.find((row) => row.active === true)?.login ?? null;
    return { logins: [...new Set(logins)], active };
  } catch {
    return { logins: [], active: null };
  }
};

export type GitCredentialResponse = { stdout: string; stderr: string; exitCode: number };

/** Implement Git's credential helper protocol for get|store|erase. */
export const gitCredentialResponse = async (input: {
  account: string;
  operation: string;
  stdin: string;
  runner: AuthProcessRunner;
  cwd?: string;
}): Promise<GitCredentialResponse> => {
  if (input.operation === "store" || input.operation === "erase") {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  if (input.operation !== "get") {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  const fields = new Map<string, string>();
  for (const line of input.stdin.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    fields.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  if (fields.get("protocol") !== "https" || fields.get("host") !== GITHUB_HOST) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  try {
    const token = await resolveGitHubToken(input.account, input.runner, input.cwd);
    return {
      stdout: `username=${input.account}\npassword=${token}\n`,
      stderr: "",
      exitCode: 0
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "quit=1\n", stderr: message.endsWith("\n") ? message : `${message}\n`, exitCode: 0 };
  }
};

export const ghEnvForAccount = async (
  account: string | null | undefined,
  runner: AuthProcessRunner,
  cwd = process.cwd()
): Promise<NodeJS.ProcessEnv | undefined> => {
  if (account === null || account === undefined || account === "") return undefined;
  const token = await resolveGitHubToken(account, runner, cwd);
  return { ...stripAmbientGitHubTokens(), GH_TOKEN: token };
};
