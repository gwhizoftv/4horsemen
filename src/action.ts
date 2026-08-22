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

/** True when a path is safe to render inside a single Markdown code span. */
export const isSafeActionPathDisplay = (value: string): boolean =>
  value.length > 0 && !value.includes("\n") && !value.includes("\r") && !value.includes("`");

const renderPathList = (paths: readonly string[]): { rendered: string[]; omitted: number } => {
  const rendered: string[] = [];
  let omitted = 0;
  for (const path of paths) {
    if (!isSafeActionPathDisplay(path)) {
      omitted += 1;
      continue;
    }
    rendered.push(`\`${path}\``);
  }
  return { rendered, omitted };
};

const renderRepoContextSection = (contextPaths: readonly string[]): string => {
  if (contextPaths.length === 0) return "";
  const { rendered, omitted } = renderPathList(contextPaths);
  if (rendered.length === 0 && omitted === 0) return "";
  const lines = [
    "",
    "## Repo context",
    "",
    "Read these repository-relative files first for orientation; they replace an initial find/grep sweep, not judgment or bound pins.",
    ""
  ];
  for (const path of rendered) lines.push(`- ${path}`);
  if (omitted > 0) {
    lines.push(`- (${omitted} configured context path(s) omitted: unsafe to render in this action)`);
  }
  lines.push("");
  return lines.join("\n");
};

const renderChangeScopeSection = (changeScope: readonly ChangeScopeEntry[]): string => {
  if (changeScope.length === 0) return "";
  const blocks: string[] = [
    "",
    "## Changed paths for the bound pins",
    "",
    "Informational only. `approvedPaths` remains the only authority for which paths an implementation may touch.",
    ""
  ];
  for (const entry of changeScope) {
    blocks.push(`- ${entry.agent} @ \`${entry.commitSha}\`:`);
    const { rendered, omitted } = renderPathList(entry.paths);
    if (rendered.length === 0) {
      blocks.push("  - (no safely renderable paths)");
    } else {
      for (const path of rendered) blocks.push(`  - ${path}`);
    }
    if (entry.truncated) {
      blocks.push("  - (list truncated; more paths changed than shown)");
    }
    if (omitted > 0) {
      blocks.push(`  - (${omitted} path(s) omitted: unsafe to render in this action)`);
    }
  }
  blocks.push("");
  return blocks.join("\n");
};

export const renderAction = (order: InternalOrder): string => {
  if (!actionIdPattern.test(order.actionId)) throw new Error("actionId must be an opaque UUID.");
  if (!agentPattern.test(order.agent)) throw new Error(`Invalid action agent ${order.agent}.`);
  repositoryPathSchema.parse(order.requiredPath);
  validatePublicField("completePath", order.completePath);
  for (const path of order.contextPaths ?? []) {
    if (path.includes("\n") || path.includes("\r")) {
      throw new Error("context path must fit on one line.");
    }
  }

  const inputText =
    order.inputs.length === 0
      ? "- No peer commits are required for this action."
      : order.inputs
          .map((input) => `- ${input.kind} from ${input.agent}: \`${input.commitSha}\` at \`${input.path}\``)
          .join("\n");

  const contextSection = renderRepoContextSection(order.contextPaths ?? []);
  const changeScopeSection = renderChangeScopeSection(order.changeScope ?? []);

  return `---
actionId: ${order.actionId}
agent: ${order.agent}
requiredPath: ${order.requiredPath}
---

${order.task}
${contextSection}${changeScopeSection}
Publish the required artifact at:

\`${order.requiredPath}\`

Use these exact inputs (dropped agents are intentionally omitted):

${inputText}

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
