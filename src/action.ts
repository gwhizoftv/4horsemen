import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { assertNoSymlink, containedPath } from "./paths.js";
import { gitShaSchema, repositoryPathSchema } from "./protocol.js";
import type { ChangeScopeEntry, InternalOrder, SubmissionMode } from "./steps.js";

/**
 * The two action shapes, as a closed union.
 *
 * A Git action names a repository path; a response action names an absolute
 * runtime path. Overloading one field would make every forbidden combination
 * parse — a repository validator run against a runtime path, or a response
 * marker accepted for an action that wanted a commit — so the discriminator is
 * explicit and each variant forbids the other's fields outright.
 */
export type GitAction = {
  submissionMode: "git";
  actionId: string;
  agent: string;
  requiredPath: string;
  body: string;
};

export type ResponseAction = {
  submissionMode: "response";
  actionId: string;
  agent: string;
  responsePath: string;
  body: string;
};

export type PublicAction = GitAction | ResponseAction;

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

const GIT_SUBMISSION_INSTRUCTIONS = (order: InternalOrder): string => `
Publish the required artifact at:

\`${order.requiredPath}\`
${boundInputsSection(order)}

Push the commit containing the artifact to \`${order.branch}\`. Then write that
exact 40-character lowercase commit SHA as the sole contents of:

\`${order.completePath}\`
`;

/**
 * No branch, no commit, no push, and no repository path.
 *
 * The response file is written first and the marker second, and the action says
 * so, because the coordinator reads the response only after the marker exists:
 * marker-first would let it read a half-written file and reject a judgment the
 * agent was in the middle of writing correctly.
 */
const RESPONSE_SUBMISSION_INSTRUCTIONS = (order: InternalOrder, responsePath: string): string => `
Write your response to:

\`${responsePath}\`
${boundInputsSection(order)}

Do not commit or push anything for this action. Then, after the response file is
completely written, write this exact single line as the sole contents of:

\`${order.completePath}\`

\`\`\`text
response ${order.actionId}
\`\`\`
`;

const boundInputsSection = (order: InternalOrder): string => {
  const inputText =
    order.inputs.length === 0
      ? "- No peer commits are required for this action."
      : order.inputs
          .map((input) => `- ${input.kind} from ${input.agent}: \`${input.commitSha}\` at \`${input.path}\``)
          .join("\n");
  return `
Use these exact inputs (dropped agents are intentionally omitted):

${inputText}${repoContextSection(order.contextPaths)}${changeScopeSection(order.changeScope)}`;
};

const REREAD_NOTE = `
After writing that, keep this file. Before waiting for more input, re-read
it. If \`actionId\` in the front matter has changed, execute the new instructions
immediately; do not wait for another coordinator message.
`;

export const renderAction = (order: InternalOrder): string => {
  if (!actionIdPattern.test(order.actionId)) throw new Error("actionId must be an opaque UUID.");
  if (!agentPattern.test(order.agent)) throw new Error(`Invalid action agent ${order.agent}.`);
  validatePublicField("completePath", order.completePath);

  if (order.submissionMode === "response") {
    const responsePath = order.responsePath;
    if (responsePath === null) throw new Error("A response action must carry a responsePath.");
    validatePublicField("responsePath", responsePath);
    if (!responsePath.startsWith("/")) throw new Error("responsePath must be absolute.");
    return `---
actionId: ${order.actionId}
agent: ${order.agent}
submissionMode: response
responsePath: ${responsePath}
---

${order.task}
${RESPONSE_SUBMISSION_INSTRUCTIONS(order, responsePath)}${REREAD_NOTE}`;
  }

  repositoryPathSchema.parse(order.requiredPath);
  return `---
actionId: ${order.actionId}
agent: ${order.agent}
submissionMode: git
requiredPath: ${order.requiredPath}
---

${order.task}
${GIT_SUBMISSION_INSTRUCTIONS(order)}${REREAD_NOTE}`;
};

const ALLOWED_FIELDS = ["actionId", "agent", "submissionMode", "requiredPath", "responsePath"] as const;

export const parseAction = (raw: string): PublicAction => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (match === null) throw new Error("action.md must contain restricted front matter.");
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Malformed action front-matter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!(ALLOWED_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Forbidden action front-matter field: ${key}`);
    }
    if (fields[key] !== undefined) throw new Error(`Duplicate action front-matter field: ${key}`);
    fields[key] = value;
  }
  const actionId = fields.actionId;
  const agent = fields.agent;
  if (actionId === undefined || !actionIdPattern.test(actionId)) throw new Error("Invalid or missing actionId.");
  if (agent === undefined || !agentPattern.test(agent)) throw new Error("Invalid or missing agent.");
  const body = match[2] as string;

  // A missing discriminator is read as `git`, which is what every action
  // written before response mode existed is. It is the only defaulting here:
  // once a mode is stated, the other mode's fields are refused outright.
  const submissionMode = fields.submissionMode ?? "git";
  if (submissionMode === "response") {
    const responsePath = fields.responsePath;
    if (fields.requiredPath !== undefined) {
      throw new Error("A response action must not carry requiredPath.");
    }
    if (responsePath === undefined || !responsePath.startsWith("/")) {
      throw new Error("A response action requires an absolute responsePath.");
    }
    return { submissionMode: "response", actionId, agent, responsePath, body };
  }
  if (submissionMode !== "git") throw new Error(`Unknown submissionMode ${submissionMode}.`);
  if (fields.responsePath !== undefined) {
    throw new Error("A Git action must not carry responsePath.");
  }
  const requiredPath = fields.requiredPath;
  if (requiredPath === undefined) throw new Error("Missing requiredPath.");
  repositoryPathSchema.parse(requiredPath);
  return { submissionMode: "git", actionId, agent, requiredPath, body };
};

export type CompletionParseResult =
  | { status: "missing" }
  | { status: "valid"; kind: "git"; sha: string }
  | { status: "valid"; kind: "response"; actionId: string }
  | { status: "malformed"; message: string };

/**
 * Parse the completion marker, optionally bound to the mode that was ordered.
 *
 * Passing `expected` is what makes a marker unable to satisfy the wrong kind of
 * action: a pushed SHA cannot answer a ballot, and a `response` line cannot
 * answer an action that wanted a commit. Without the binding, an agent that
 * answered the previous action in the previous mode would look like it had
 * answered this one.
 */
export const parseCompletion = (
  raw: string,
  expected?: SubmissionMode
): CompletionParseResult => {
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (normalized === "") return { status: "malformed", message: "complete must contain one line" };
  if (normalized.includes("\n") || normalized.includes("\r") || normalized !== normalized.trim()) {
    return { status: "malformed", message: "complete must contain exactly one unpadded line" };
  }

  const response = /^response ([0-9a-fA-F-]{36})$/.exec(normalized);
  if (response !== null) {
    const actionId = response[1] as string;
    if (!actionIdPattern.test(actionId)) {
      return { status: "malformed", message: "response marker must name an opaque action id" };
    }
    if (expected === "git") {
      return {
        status: "malformed",
        message: "this action is completed with a pushed 40-character commit SHA, not a response marker"
      };
    }
    return { status: "valid", kind: "response", actionId };
  }

  const match = /^(?:commit )?([a-f0-9]{40})$/.exec(normalized);
  const parsed = gitShaSchema.safeParse(match?.[1]);
  if (!parsed.success) {
    return {
      status: "malformed",
      message:
        expected === "response"
          ? "complete must contain exactly `response <action-id>` for this action"
          : "complete must contain a 40-character lowercase Git SHA"
    };
  }
  if (expected === "response") {
    return {
      status: "malformed",
      message: "this action is completed with a response marker, not a pushed commit SHA"
    };
  }
  return { status: "valid", kind: "git", sha: parsed.data };
};

export const readCompletion = (path: string, expected?: SubmissionMode): CompletionParseResult => {
  if (!existsSync(path)) return { status: "missing" };
  return parseCompletion(readFileSync(path, "utf8"), expected);
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
