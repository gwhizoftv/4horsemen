import { z } from "zod";

export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type CommandRunner = (argv: readonly string[], cwd: string) => Promise<CommandResult>;

const issueResponseSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    url: z.string().url()
  })
  .strict();

export type GitHubIssueSnapshot = {
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
};

export const githubRepositoryFromOrigin = (origin: string): string | null => {
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(origin);
  if (https?.[1] !== undefined) return https[1].replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+\/[^/]+)$/.exec(origin);
  return ssh?.[1]?.replace(/\.git$/, "") ?? null;
};

export const renderGitHubIssueSnapshot = (snapshot: GitHubIssueSnapshot): string =>
  `${JSON.stringify(snapshot, null, 2)}\n`;

const remediation = (repository: string, issue: number): string =>
  `Create GitHub issue ${issue} in ${repository} first, or repair GitHub CLI access with \`gh auth status\`.`;

export const fetchGitHubIssue = async (input: {
  origin: string;
  issue: number;
  cwd: string;
  runner: CommandRunner;
}): Promise<GitHubIssueSnapshot> => {
  const repository = githubRepositoryFromOrigin(input.origin);
  if (repository === null) {
    throw new Error(
      `Cannot read GitHub issue ${input.issue}: origin ${input.origin} is not a supported github.com repository. ` +
        `Point the workspace at the GitHub repository that owns the issue, create issue ${input.issue} there first, ` +
        "and verify GitHub CLI access with `gh auth status`."
    );
  }

  let result: CommandResult;
  try {
    result = await input.runner(
      [
        "gh",
        "issue",
        "view",
        String(input.issue),
        "--repo",
        repository,
        "--json",
        "number,title,body,url"
      ],
      input.cwd
    );
  } catch (error) {
    throw new Error(
      `Cannot read GitHub issue ${input.issue} from ${repository}: ${error instanceof Error ? error.message : String(error)}. ` +
        remediation(repository, input.issue)
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `gh exited ${result.exitCode}`;
    throw new Error(`Cannot read GitHub issue ${input.issue} from ${repository}: ${detail}. ${remediation(repository, input.issue)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(
      `GitHub issue ${input.issue} from ${repository} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}. ` +
        remediation(repository, input.issue)
    );
  }
  const parsed = issueResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `GitHub issue ${input.issue} from ${repository} returned an invalid snapshot. ${remediation(repository, input.issue)}`
    );
  }
  if (parsed.data.number !== input.issue) {
    throw new Error(
      `GitHub returned issue ${parsed.data.number} while issue ${input.issue} was requested from ${repository}. ` +
        remediation(repository, input.issue)
    );
  }
  return { repository, ...parsed.data };
};
