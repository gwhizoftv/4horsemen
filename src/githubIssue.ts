import { z } from "zod";

/**
 * The work statement for a run: GitHub issue N, fetched at start.
 *
 * This replaces the owner-authored plan file the digest used to hash. The
 * owner creates a GitHub issue; agents author their own plans on their own
 * branches. Nothing here fetches comments, labels, or later edits — an active
 * run binds the title and body as they were at start, so a session cannot
 * silently rebind to rewritten text.
 */

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };
export type ArgvRunner = (argv: readonly string[], cwd: string) => Promise<ProcessResult>;

export const issueSnapshotSchema = z
  .object({
    repository: z.string().min(1),
    number: z.number().int().min(1),
    title: z.string(),
    body: z.string(),
    url: z.string().min(1)
  })
  .strict();

export type IssueSnapshot = z.infer<typeof issueSnapshotSchema>;

export const githubRepositoryFromOrigin = (origin: string): string | null => {
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(origin);
  if (https?.[1] !== undefined) return https[1].replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+\/[^/]+)$/.exec(origin);
  return ssh?.[1]?.replace(/\.git$/, "") ?? null;
};

/**
 * The exact bytes that are both hashed into the digest and written to
 * `issue-N/github-issue.json`.
 *
 * Key order is fixed here rather than left to `JSON.stringify` of a
 * differently-shaped object, and no fetch timestamp appears: re-hashing the
 * persisted file must reproduce `automationDigest`, which it cannot do if the
 * bytes carry the moment they were fetched.
 */
export const canonicalIssueSnapshot = (snapshot: IssueSnapshot): string =>
  `${JSON.stringify(
    {
      repository: snapshot.repository,
      number: snapshot.number,
      title: snapshot.title,
      body: snapshot.body,
      url: snapshot.url
    },
    null,
    2
  )}\n`;

export class IssueFetchError extends Error {
  override readonly name = "IssueFetchError";
}

const ghResponseSchema = z
  .object({
    number: z.number().int().min(1),
    title: z.string(),
    body: z.string().nullable(),
    url: z.string().min(1)
  })
  .strict();

export type FetchIssueInput = {
  origin: string;
  issue: number;
  runner: ArgvRunner;
  cwd: string;
};

/**
 * Fetch issue N from the repository the workspace's origin names.
 *
 * `--repo` is explicit and derived from `config.origin`, never from the process
 * working directory: `coord 42 --product /path/to/A` launched from inside
 * product B must hash A's issue 42, not B's.
 */
export const fetchIssueSnapshot = async (input: FetchIssueInput): Promise<IssueSnapshot> => {
  const repository = githubRepositoryFromOrigin(input.origin);
  if (repository === null) {
    throw new IssueFetchError(
      `The work statement for a run is GitHub issue ${input.issue}, but origin ${input.origin} is not a github.com repository.\n` +
        "  Point origin at github.com, or declare the run's inputs explicitly with digestPaths."
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
    "number,title,body,url"
  ];
  let result: ProcessResult;
  try {
    result = await input.runner(argv, input.cwd);
  } catch (error) {
    throw new IssueFetchError(
      `Cannot run gh to read ${repository}#${input.issue}: ${error instanceof Error ? error.message : String(error)}\n` +
        "  Install the GitHub CLI (https://cli.github.com) and authenticate with: gh auth login"
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new IssueFetchError(
      `Cannot read GitHub issue ${repository}#${input.issue}: ${detail || `gh exited ${result.exitCode}`}\n` +
        `  Create the GitHub issue first:  gh issue create --repo ${repository}\n` +
        "  If it exists, check access:     gh auth status"
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new IssueFetchError(
      `gh returned output for ${repository}#${input.issue} that is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const parsed = ghResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new IssueFetchError(`gh returned an unexpected issue shape for ${repository}#${input.issue}: ${parsed.error.message}`);
  }
  // The response is what binds the session; a reply about a different issue
  // would hash the wrong work statement under the right issue's runtime.
  if (parsed.data.number !== input.issue) {
    throw new IssueFetchError(
      `Asked ${repository} for issue ${input.issue} but gh returned issue ${parsed.data.number}.`
    );
  }
  return issueSnapshotSchema.parse({
    repository,
    number: parsed.data.number,
    title: parsed.data.title,
    body: parsed.data.body ?? "",
    url: parsed.data.url
  });
};
