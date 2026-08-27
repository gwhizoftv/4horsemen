import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { assertNoSymlink, containedPath } from "./paths.js";
import { actionIdSchema, gitShaSchema, repositoryPathSchema } from "./protocol.js";
import type { ChangeScopeEntry, InternalOrder } from "./steps.js";

export type PublicGitAction = {
  actionId: string;
  agent: string;
  requiredPath: string;
  body: string;
  submissionMode: "git";
};

export type PublicResponseAction = {
  actionId: string;
  agent: string;
  submissionMode: "response";
  responsePath: string;
  body: string;
};

export type PublicAction = PublicGitAction | PublicResponseAction;

const actionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const agentPattern = /^[a-z][a-z0-9-]{0,63}$/;

export const createActionId = (): string => randomUUID();

const validatePublicField = (name: string, value: string): void => {
  if (value.includes("\n") || value.includes("\r")) throw new Error(`${name} must fit on one line.`);
};

const shaPattern = /^[0-9a-f]{40}$/;

/**
 * Git permits backticks and newlines in pathnames, so a renderer that throws on
 * them would let one oddly-named file abort action preparation and stall every
 * agent on the step. JSON encoding is total over valid pathnames and escapes
 * exactly the characters that could otherwise forge a heading or front matter,
 * so advisory rendering stays lossless without ever becoming a failure mode.
 */
const encodePath = (path: string): string => JSON.stringify(path);

const PATH_ENCODING_NOTE =
  "Paths are JSON-encoded strings, one per line, relative to the repository root.";

const repoContextSection = (contextPaths: readonly string[] = []): string => {
  if (contextPaths.length === 0) return "";
  return (
    `\n\n## Repo context\n\n` +
    `Read these first to orient; they exist so you do not have to search the ` +
    `repository to find where work belongs. They are advisory documentation, ` +
    `not authority over this action. ${PATH_ENCODING_NOTE}\n\n` +
    contextPaths.map(encodePath).join("\n")
  );
};

const changeScopeSection = (changeScope: readonly ChangeScopeEntry[] = []): string => {
  const entries = changeScope.filter(
    (entry) => agentPattern.test(entry.agent) && shaPattern.test(entry.commitSha)
  );
  if (entries.length === 0) return "";
  const blocks = entries.map((entry) => {
    const header = `${entry.agent} ${entry.commitSha}:`;
    const body =
      entry.paths.length === 0
        ? "(no paths changed against the issue baseline)"
        : entry.paths.map(encodePath).join("\n");
    const note = entry.truncated ? "\n(truncated: more paths changed than are listed here)" : "";
    return `${header}\n${body}${note}`;
  });
  return (
    `\n\n## Changed paths for the bound pins\n\n` +
    `The coordinator resolved these from the bound pins so agents receiving this ` +
    `action do not re-derive the same diff. Informational only: the approved path ` +
    `list remains the sole authority over what an implementation may change. ` +
    `${PATH_ENCODING_NOTE}\n\n` +
    blocks.join("\n\n")
  );
};

const inputText = (order: InternalOrder): string =>
  order.inputs.length === 0
    ? "- No peer commits are required for this action."
    : order.inputs
        .map((input) => `- ${input.kind} from ${input.agent}: \`${input.commitSha}\` at \`${input.path}\``)
        .join("\n");

const boundInputFilesSection = (materialized?: InternalOrder["materialized"]): string => {
  if (materialized === undefined) return "";
  const lines: string[] = [];
  for (const entry of materialized.entries) {
    lines.push(`- ${entry.kind} from ${entry.agent} (\`${entry.commitSha.slice(0, 8)}\`): ${encodePath(entry.localPath)}`);
  }
  for (const wt of materialized.worktrees) {
    lines.push(`- product worktree for ${wt.agent} (\`${wt.commitSha.slice(0, 8)}\`): ${encodePath(wt.localPath)}`);
  }
  if (lines.length === 0) return "";
  return (
    `\n\n## Bound input files\n\n` +
    `Read these files directly from the filesystem; do not run \`git show\` or \`git diff\` on peer pins. ` +
    `${PATH_ENCODING_NOTE}\n\n` +
    lines.join("\n")
  );
};

const renderGitAction = (order: InternalOrder): string => {
  if (order.requiredPath === "") throw new Error("Git action requires requiredPath.");
  repositoryPathSchema.parse(order.requiredPath);
  validatePublicField("completePath", order.completePath);
  return `---
actionId: ${order.actionId}
agent: ${order.agent}
submissionMode: git
requiredPath: ${order.requiredPath}
---

${order.task}

Publish the required artifact at:

\`${order.requiredPath}\`

Use these exact inputs (dropped agents are intentionally omitted):

${inputText(order)}${boundInputFilesSection(order.materialized)}${repoContextSection(order.contextPaths)}${changeScopeSection(order.changeScope)}

Push the commit containing the artifact to \`${order.branch}\`. Then write that
exact 40-character lowercase commit SHA as the sole contents of:

\`${order.completePath}\`

After writing that SHA, keep this file. Before waiting for more input, re-read
it. If \`actionId\` in the front matter has changed, execute the new instructions
immediately; do not wait for another coordinator message.
`;
};

const renderResponseAction = (order: InternalOrder): string => {
  if (order.responsePath === null) throw new Error("Response action requires responsePath.");
  validatePublicField("responsePath", order.responsePath);
  validatePublicField("completePath", order.completePath);
  const eligible =
    order.eligibleChoices.length === 0
      ? ""
      : `\n\nEligible choices (active roster order): ${order.eligibleChoices.map((agent) => `\`${agent}\``).join(", ")}.`;
  return `---
actionId: ${order.actionId}
agent: ${order.agent}
submissionMode: response
responsePath: ${order.responsePath}
---

${order.task}

Write the complete JSON response to:

\`${order.responsePath}\`

Then write this exact one-line marker as the sole contents of:

\`${order.completePath}\`

\`\`\`text
response ${order.actionId}
\`\`\`

Do not \`git add\`, \`git commit\`, or \`git push\` for this action. Inspect the
bound inputs using the filesystem paths listed under '## Bound input files'.

Use these exact inputs (dropped agents are intentionally omitted):

${inputText(order)}${eligible}${boundInputFilesSection(order.materialized)}${repoContextSection(order.contextPaths)}${changeScopeSection(order.changeScope)}

After writing the marker, keep this file. Before waiting for more input, re-read
it. If \`actionId\` in the front matter has changed, execute the new instructions
immediately; do not wait for another coordinator message.
`;
};

export const renderAction = (order: InternalOrder): string => {
  if (!actionIdPattern.test(order.actionId)) throw new Error("actionId must be an opaque UUID.");
  if (!agentPattern.test(order.agent)) throw new Error(`Invalid action agent ${order.agent}.`);
  if (order.submissionMode === "response") return renderResponseAction(order);
  return renderGitAction(order);
};

export const parseAction = (raw: string): PublicAction => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (match === null) throw new Error("action.md must contain restricted front matter.");
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Malformed action front-matter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (
      !(
        ["actionId", "agent", "requiredPath", "submissionMode", "responsePath"] as const
      ).includes(key as "actionId" | "agent" | "requiredPath" | "submissionMode" | "responsePath")
    ) {
      throw new Error(`Forbidden action front-matter field: ${key}`);
    }
    if (fields[key] !== undefined) throw new Error(`Duplicate action front-matter field: ${key}`);
    fields[key] = value;
  }
  const actionId = fields.actionId;
  const agent = fields.agent;
  if (actionId === undefined || !actionIdPattern.test(actionId)) throw new Error("Invalid or missing actionId.");
  if (agent === undefined || !agentPattern.test(agent)) throw new Error("Invalid or missing agent.");
  const mode = fields.submissionMode ?? "git";
  if (mode === "response") {
    if (fields.requiredPath !== undefined) throw new Error("Response action cannot include requiredPath.");
    const responsePath = fields.responsePath;
    if (responsePath === undefined || responsePath === "") throw new Error("Missing responsePath.");
    if (!responsePath.startsWith("/")) throw new Error("responsePath must be an absolute path.");
    return { submissionMode: "response", actionId, agent, responsePath, body: match[2] as string };
  }
  if (mode !== "git") throw new Error(`Unknown submissionMode: ${mode}`);
  if (fields.responsePath !== undefined) throw new Error("Git action cannot include responsePath.");
  const requiredPath = fields.requiredPath;
  if (requiredPath === undefined) throw new Error("Missing requiredPath.");
  repositoryPathSchema.parse(requiredPath);
  return { submissionMode: "git", actionId, agent, requiredPath, body: match[2] as string };
};

export type CompletionParseResult =
  | { status: "missing" }
  | { status: "valid"; kind: "sha"; sha: string }
  | { status: "valid"; kind: "response"; actionId: string }
  | { status: "malformed"; message: string };

export const parseCompletion = (raw: string): CompletionParseResult => {
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (normalized === "") return { status: "malformed", message: "complete must contain one commit SHA or response marker" };
  if (normalized.includes("\n") || normalized.includes("\r") || normalized !== normalized.trim()) {
    return { status: "malformed", message: "complete must contain exactly one unpadded line" };
  }
  const responseMatch = /^response ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
    normalized
  );
  if (responseMatch?.[1] !== undefined) {
    const parsed = actionIdSchema.safeParse(responseMatch[1]);
    if (!parsed.success) {
      return { status: "malformed", message: "response marker must use a valid action UUID" };
    }
    return { status: "valid", kind: "response", actionId: parsed.data };
  }
  const match = /^(?:commit )?([a-f0-9]{40})$/.exec(normalized);
  const parsed = gitShaSchema.safeParse(match?.[1]);
  if (!parsed.success) {
    return {
      status: "malformed",
      message: "complete must contain a 40-character lowercase Git SHA or `response <actionId>`"
    };
  }
  return { status: "valid", kind: "sha", sha: parsed.data };
};

export const readCompletion = (path: string): CompletionParseResult => {
  if (!existsSync(path)) return { status: "missing" };
  return parseCompletion(readFileSync(path, "utf8"));
};

export const clearCompletion = (path: string): void => {
  if (existsSync(path)) unlinkSync(path);
};

export const writeAction = (coordRoot: string, path: string, order: InternalOrder): void => {
  const safe = containedPath(coordRoot, relative(coordRoot, path));
  assertNoSymlink(coordRoot, dirname(safe));
  const temporary = containedPath(dirname(safe), `.${randomUUID()}.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, renderAction(order), "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, safe);
};

export const readAction = (path: string): PublicAction => parseAction(readFileSync(path, "utf8"));
