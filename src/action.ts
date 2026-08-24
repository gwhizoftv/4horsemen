import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { assertNoSymlink, containedPath } from "./paths.js";
import { gitShaSchema, repositoryPathSchema } from "./protocol.js";
import type { ChangeScopeEntry, InternalOrder } from "./steps.js";

export type PublicAction = {
  actionId: string;
  agent: string;
  requiredPath: string;
  body: string;
};

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
    `The coordinator resolved these from the bound pins so that no agent has to ` +
    `re-derive the same diff. Informational only: the ` +
    `approved path list remains the sole authority over what an implementation ` +
    `may change. ${PATH_ENCODING_NOTE}\n\n` +
    blocks.join("\n\n")
  );
};

export const renderAction = (order: InternalOrder): string => {
  if (!actionIdPattern.test(order.actionId)) throw new Error("actionId must be an opaque UUID.");
  if (!agentPattern.test(order.agent)) throw new Error(`Invalid action agent ${order.agent}.`);
  repositoryPathSchema.parse(order.requiredPath);
  validatePublicField("completePath", order.completePath);

  const inputText =
    order.inputs.length === 0
      ? "- No peer commits are required for this action."
      : order.inputs
          .map((input) => `- ${input.kind} from ${input.agent}: \`${input.commitSha}\` at \`${input.path}\``)
          .join("\n");

  return `---
actionId: ${order.actionId}
agent: ${order.agent}
requiredPath: ${order.requiredPath}
---

${order.task}

Publish the required artifact at:

\`${order.requiredPath}\`

Use these exact inputs (dropped agents are intentionally omitted):

${inputText}${repoContextSection(order.contextPaths)}${changeScopeSection(order.changeScope)}

Push the commit containing the artifact to \`${order.branch}\`. Then write that
exact 40-character lowercase commit SHA as the sole contents of:

\`${order.completePath}\`

After writing that SHA, keep this file. Before waiting for more input, re-read
it. If \`actionId\` in the front matter has changed, execute the new instructions
immediately; do not wait for another coordinator message.
`;
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
    if (!(["actionId", "agent", "requiredPath"] as const).includes(key as "actionId" | "agent" | "requiredPath")) {
      throw new Error(`Forbidden action front-matter field: ${key}`);
    }
    if (fields[key] !== undefined) throw new Error(`Duplicate action front-matter field: ${key}`);
    fields[key] = value;
  }
  const actionId = fields.actionId;
  const agent = fields.agent;
  const requiredPath = fields.requiredPath;
  if (actionId === undefined || !actionIdPattern.test(actionId)) throw new Error("Invalid or missing actionId.");
  if (agent === undefined || !agentPattern.test(agent)) throw new Error("Invalid or missing agent.");
  if (requiredPath === undefined) throw new Error("Missing requiredPath.");
  repositoryPathSchema.parse(requiredPath);
  return { actionId, agent, requiredPath, body: match[2] as string };
};

export type CompletionParseResult =
  | { status: "missing" }
  | { status: "valid"; sha: string }
  | { status: "malformed"; message: string };

export const parseCompletion = (raw: string): CompletionParseResult => {
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (normalized === "") return { status: "malformed", message: "complete must contain one commit SHA" };
  if (normalized.includes("\n") || normalized.includes("\r") || normalized !== normalized.trim()) {
    return { status: "malformed", message: "complete must contain exactly one unpadded line" };
  }
  const match = /^(?:commit )?([a-f0-9]{40})$/.exec(normalized);
  const parsed = gitShaSchema.safeParse(match?.[1]);
  if (!parsed.success) {
    return { status: "malformed", message: "complete must contain a 40-character lowercase Git SHA" };
  }
  return { status: "valid", sha: parsed.data };
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
