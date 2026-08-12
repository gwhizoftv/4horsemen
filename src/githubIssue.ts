import { z } from "zod";

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };
export type IssueProcessRunner = (argv: readonly string[], cwd: string) => Promise<ProcessResult>;

export type GitHubIssueSnapshot = {
  repository: string;
  number: number;
  title: string;
  body: string;
};

const ghIssueViewSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable()
  })
  .strict();

export const githubRepositoryFromOrigin = (origin: string): string | null => {
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(origin);
  if (https?.[1] !== undefined) return https[1].replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+\/[^/]+)$/.exec(origin);
  return ssh?.[1]?.replace(/\.git$/, "") ?? null;
};

export const renderGitHubIssueSnapshot = (snapshot: GitHubIssueSnapshot): string =>
  `${JSON.stringify(snapshot, null, 2)}\n`;

export const githubIssueRemediation = (issue: number, repository: string | null): string => {
  const repo = repository ?? "<owner>/<repo>";
  return (
    `Create GitHub issue ${issue} first (gh issue create --repo ${repo}), ` +
    `or repair gh authentication (gh auth status / gh auth login).`
  );
};

export class GitHubIssueError extends Error {
  override readonly name = "GitHubIssueError";
  constructor(
    message: string,
    readonly remediation: string
  ) {
    super(`${message}\n  Fix: ${remediation}`);
  }
}

export const fetchGitHubIssueSnapshot = async (input: {
  origin: string;
  issue: number;
  runner: IssueProcessRunner;
  cwd: string;
}): Promise<{ snapshot: GitHubIssueSnapshot; bytes: string }> => {
  const repository = githubRepositoryFromOrigin(input.origin);
  if (repository === null) {
    throw new GitHubIssueError(
      `Cannot derive a github.com owner/repo from origin ${input.origin}.`,
      githubIssueRemediation(input.issue, null)
    );
  }

  const argv = [
    "gh",
    "issue",
    "view",
    String(input.issue),
    "--repo",
    repository,
    "--json",
    "number,title,body"
  ] as const;
  const result = await input.runner([...argv], input.cwd);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new GitHubIssueError(
      `Cannot read GitHub issue ${input.issue} in ${repository}: ${detail}`,
      githubIssueRemediation(input.issue, repository)
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new GitHubIssueError(
      `gh issue view returned unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
      githubIssueRemediation(input.issue, repository)
    );
  }

  const validated = ghIssueViewSchema.safeParse(parsed);
  if (!validated.success) {
    throw new GitHubIssueError(
      `gh issue view returned an unexpected payload: ${validated.error.message}`,
      githubIssueRemediation(input.issue, repository)
    );
  }
  if (validated.data.number !== input.issue) {
    throw new GitHubIssueError(
      `gh issue view returned issue ${validated.data.number}, expected ${input.issue}.`,
      githubIssueRemediation(input.issue, repository)
    );
  }

  const snapshot: GitHubIssueSnapshot = {
    repository,
    number: validated.data.number,
    title: validated.data.title,
    body: validated.data.body ?? ""
  };
  return { snapshot, bytes: renderGitHubIssueSnapshot(snapshot) };
};
