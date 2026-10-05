import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { object, stringField, type LifecycleVendor } from "./agentEvent.js";
import {
  containmentCoverage,
  readAgentLifecycle,
  recordContainmentEvidence,
  type ContainmentCoverage
} from "./agentLifecycle.js";
import { localConfigGet } from "./gitExec.js";
import { sha256OfFile } from "./hash.js";
import { resolveWorkspaceConfig } from "./hookPolicy.js";
import { issueRuntimePaths, type IssueRuntimePaths } from "./paths.js";
import { GIT_WRAPPER_RELATIVE_PATH } from "./setupWorkspace.js";
import { appendJournal, readStartState } from "./state.js";
import { workspaceLocationFromConfig } from "./workspace.js";

/**
 * The shell-tool guard: a vendor hook that sees a proposed shell command before
 * the harness runs it, so Git containment no longer depends on which `git` the
 * harness's PATH resolves. It holds no Git policy of its own. It finds the git
 * invocations in the command text and asks the clone's shim, in check mode,
 * for the verdict the shim would give if it were on PATH.
 *
 * Static on purpose: the text is never executed to classify it. Scripts,
 * `eval`, dynamically built command words, and input typed into an already
 * open terminal are outside what this can see, and are allowed.
 */

/** What each vendor accepts as "no objection". Claude and Codex take empty output. */
export const SHELL_GUARD_ALLOW: Readonly<Record<LifecycleVendor, string>> = {
  claude: "",
  codex: "",
  cursor: JSON.stringify({ permission: "allow" }),
  antigravity: JSON.stringify({ decision: "allow" })
};

const BOUND_INPUTS_POINTER =
  "Read bound peer artifacts from the paths under '## Bound input files' in your action.md instead.";

export const shellGuardDenyResponse = (vendor: LifecycleVendor, reason: string): string => {
  switch (vendor) {
    case "claude":
    case "codex":
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
      });
    case "cursor":
      return JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason });
    case "antigravity":
      return JSON.stringify({ decision: "deny", reason });
  }
};

export type ShellRequest = {
  /** Shell text, or an argv the harness will exec directly. */
  command: string | readonly string[];
  cwd: string | null;
  sessionId: string | null;
  vendorVersion: string | null;
};

const commandValue = (value: unknown): string | readonly string[] | null => {
  if (typeof value === "string" && value !== "") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return null;
};

/** Normalize one vendor's pre-execution payload; null means "not a shell call we can read". */
export const readShellRequest = (vendor: LifecycleVendor, rawValue: unknown): ShellRequest | null => {
  const raw = object(rawValue);
  if (raw === null) return null;
  if (vendor === "claude" || vendor === "codex") {
    const input = object(raw.tool_input);
    const command = input === null ? null : commandValue(input.command);
    if (command === null) return null;
    return {
      command,
      cwd: stringField(raw, "cwd") ?? null,
      sessionId: stringField(raw, "session_id") ?? null,
      vendorVersion: null
    };
  }
  if (vendor === "cursor") {
    const command = commandValue(raw.command);
    if (command === null) return null;
    return {
      command,
      cwd: stringField(raw, "cwd") ?? null,
      sessionId: stringField(raw, "conversation_id", "session_id") ?? null,
      vendorVersion: stringField(raw, "cursor_version") ?? null
    };
  }
  const args = object(object(raw.toolCall)?.args);
  const command = args === null ? null : commandValue(args.CommandLine);
  if (args === null || command === null) return null;
  return {
    command,
    cwd: stringField(args, "Cwd") ?? null,
    sessionId: stringField(raw, "sessionId", "conversationId", "session_id") ?? null,
    vendorVersion: null
  };
};

// ---------------------------------------------------------------------------
// Static shell splitting. Bounded: it only has to find literal git invocations
// and the directory they run in, not interpret shell.

type Word = { value: string; dynamic: boolean };
type Token = { kind: "word"; word: Word } | { kind: "sep" };

const SEPARATORS = ["&&", "||", "|&", ";;", ";", "&", "|", "(", ")"];
const REDIRECTIONS = ["<<<", "<<-", "<<", ">>", ">&", "<&", "&>", ">|", "<>", ">", "<"];

const consumeBalanced = (text: string, start: number, open: string, close: string): number => {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
};

export const tokenizeShell = (text: string): Token[] => {
  const tokens: Token[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let value = "";
  let dynamic = false;
  let started = false;
  let skipNextWord = false;
  let heredocNext: { stripTabs: boolean } | null = null;

  const flush = (): void => {
    if (!started) return;
    if (heredocNext !== null) {
      heredocs.push({ delimiter: value, stripTabs: heredocNext.stripTabs });
      heredocNext = null;
    } else if (skipNextWord) {
      skipNextWord = false;
    } else {
      tokens.push({ kind: "word", word: { value, dynamic } });
    }
    value = "";
    dynamic = false;
    started = false;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\n") {
      flush();
      tokens.push({ kind: "sep" });
      i += 1;
      // Heredoc bodies are data, not commands.
      while (heredocs.length > 0) {
        const doc = heredocs.shift() as { delimiter: string; stripTabs: boolean };
        while (i < text.length) {
          const end = text.indexOf("\n", i);
          const line = text.slice(i, end === -1 ? text.length : end);
          i = end === -1 ? text.length : end + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
        }
      }
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      i += 1;
      continue;
    }
    if (ch === "#" && !started) {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "\\") {
      if (text[i + 1] === "\n") {
        i += 2;
        continue;
      }
      value += text[i + 1] ?? "";
      started = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      value += text.slice(i + 1, end === -1 ? text.length : end);
      started = true;
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === '"') {
      started = true;
      i += 1;
      while (i < text.length && text[i] !== '"') {
        const inner = text[i] as string;
        if (inner === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1] as string)) {
          if (text[i + 1] !== "\n") value += text[i + 1];
          i += 2;
        } else {
          if (inner === "$" || inner === "`") dynamic = true;
          value += inner;
          i += 1;
        }
      }
      i += 1;
      continue;
    }
    if (ch === "$") {
      dynamic = true;
      started = true;
      const next = text[i + 1];
      const end = next === "(" ? consumeBalanced(text, i + 1, "(", ")") : next === "{" ? consumeBalanced(text, i + 1, "{", "}") : i + 1;
      value += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      dynamic = true;
      started = true;
      value += text.slice(i, end === -1 ? text.length : end + 1);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    const redirection = REDIRECTIONS.find((op) => text.startsWith(op, i));
    if (redirection !== undefined) {
      // A word of bare digits right before the operator is its file descriptor.
      if (started && /^[0-9]+$/.test(value) && !dynamic) {
        value = "";
        started = false;
      } else {
        flush();
      }
      i += redirection.length;
      if (redirection === "<<" || redirection === "<<-") heredocNext = { stripTabs: redirection === "<<-" };
      else if ((redirection === ">&" || redirection === "<&") && /[0-9-]/.test(text[i] ?? "")) {
        while (/[0-9-]/.test(text[i] ?? "")) i += 1;
      } else skipNextWord = true;
      continue;
    }
    const separator = SEPARATORS.find((op) => text.startsWith(op, i));
    if (separator !== undefined) {
      flush();
      tokens.push({ kind: "sep" });
      i += separator.length;
      continue;
    }
    value += ch;
    started = true;
    i += 1;
  }
  flush();
  return tokens;
};

export type GitInvocation = { argv: string[]; cwd: string | null; env: Record<string, string> };

const KEYWORDS = new Set(["!", "{", "}", "if", "then", "elif", "else", "do", "while", "until", "time", "nohup", "exec", "builtin"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const MAX_DEPTH = 4;

type Context = { cwd: string | null; home: string | null };

const changeDirectory = (context: Context, args: readonly Word[]): void => {
  const target = args.find((arg) => !arg.value.startsWith("-") || arg.value === "-");
  if (target === undefined) {
    context.cwd = context.home;
    return;
  }
  // Anything not literally resolvable leaves the directory unknown, and an
  // unknown directory is never refused.
  const value = target.value === "~" || target.value.startsWith("~/")
    ? context.home === null ? null : join(context.home, target.value.slice(1))
    : target.value;
  if (target.dynamic || value === null || value === "-") context.cwd = null;
  else if (isAbsolute(value)) context.cwd = value;
  else context.cwd = context.cwd === null ? null : resolve(context.cwd, value);
};

const analyzeWords = (words: readonly Word[], context: Context, depth: number, out: GitInvocation[]): void => {
  let index = 0;
  const env: Record<string, string> = {};
  const skip = (): void => {
    while (index < words.length) {
      const word = words[index] as Word;
      const assignment = word.dynamic ? null : ASSIGNMENT.exec(word.value);
      if (KEYWORDS.has(word.value)) index += 1;
      else if (assignment !== null) {
        env[assignment[1] as string] = assignment[2] as string;
        index += 1;
      } else break;
    }
  };
  skip();
  // `env [-flags] [NAME=value…]` and `command [-p]` run the next word as the command.
  while (index < words.length) {
    const word = words[index] as Word;
    if (word.value === "env" || word.value === "command") {
      if (word.value === "command" && /^-[vV]$/.test(words[index + 1]?.value ?? "")) return;
      index += 1;
      while (index < words.length && (words[index] as Word).value.startsWith("-")) index += 1;
      skip();
    } else break;
  }
  const head = words[index];
  if (head === undefined || head.dynamic) return;
  const args = words.slice(index + 1);
  const name = basename(head.value);
  if (name === "cd" || name === "pushd") {
    changeDirectory(context, args);
    return;
  }
  if (SHELLS.has(name)) {
    const flagIndex = args.findIndex((arg) => !arg.value.startsWith("-"));
    const flags = (flagIndex === -1 ? args : args.slice(0, flagIndex)).map((arg) => arg.value);
    const takesScript = flags.some((flag) => !flag.startsWith("--") && flag.slice(1).includes("c"));
    const script = flagIndex === -1 ? undefined : args[flagIndex];
    if (takesScript && script !== undefined && !script.dynamic && depth < MAX_DEPTH) {
      collect(script.value, { ...context }, depth + 1, env, out);
    }
    return;
  }
  if (name === "git") {
    out.push({ argv: args.map((arg) => arg.value), cwd: context.cwd, env });
  }
};

const collect = (
  text: string,
  context: Context,
  depth: number,
  inherited: Record<string, string>,
  out: GitInvocation[]
): void => {
  let words: Word[] = [];
  const end = (): void => {
    const start = out.length;
    analyzeWords(words, context, depth, out);
    for (const invocation of out.slice(start)) invocation.env = { ...inherited, ...invocation.env };
    words = [];
  };
  for (const token of tokenizeShell(text)) {
    if (token.kind === "sep") end();
    else words.push(token.word);
  }
  end();
};

/** Every literal git invocation in a shell command, with the directory it would run in. */
export const findGitInvocations = (
  command: string | readonly string[],
  cwd: string | null,
  home: string | null = null
): GitInvocation[] => {
  const out: GitInvocation[] = [];
  const context: Context = { cwd, home };
  if (typeof command === "string") collect(command, context, 0, {}, out);
  else analyzeWords(command.map((value) => ({ value, dynamic: false })), context, 0, out);
  return out;
};

// ---------------------------------------------------------------------------

export const shimPath = (clone: string): string => join(clone, GIT_WRAPPER_RELATIVE_PATH);

export type GuardVerdict = { deny: false } | { deny: true; reason: string; subcommand: string };

/** Ask the clone's own shim, in check mode, about each git invocation. */
export const decideShellRequest = (input: {
  clone: string;
  request: ShellRequest;
  env: NodeJS.ProcessEnv;
}): GuardVerdict => {
  const shim = shimPath(input.clone);
  if (!existsSync(shim)) return { deny: false };
  const base: NodeJS.ProcessEnv = { ...input.env };
  // The delegate flag is how git's own children skip the shim. An agent
  // command that inherits or sets it is not a git child, so it gets no pass.
  delete base.COORD_GIT_DELEGATE;
  const invocations = findGitInvocations(input.request.command, input.request.cwd ?? input.clone, input.env.HOME ?? null);
  for (const invocation of invocations) {
    if (invocation.cwd === null) continue;
    try {
      if (!statSync(invocation.cwd).isDirectory()) continue;
    } catch {
      continue;
    }
    const inline = { ...invocation.env };
    delete inline.COORD_GIT_DELEGATE;
    const result = spawnSync(shim, invocation.argv, {
      cwd: invocation.cwd,
      env: { ...base, ...inline, PWD: invocation.cwd, COORD_GIT_POLICY_CHECK: "1" },
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "ignore", "pipe"]
    });
    if (result.status === 2) {
      const subcommand = invocation.argv.find((arg) => !arg.startsWith("-")) ?? "git";
      const detail = (result.stderr ?? "").trim();
      return {
        deny: true,
        subcommand,
        reason: `${detail === "" ? `coord: 'git ${subcommand}' is blocked in this clone.` : detail}\n${BOUND_INPUTS_POINTER}`
      };
    }
  }
  return { deny: false };
};

export const policyRevision = (clone: string): string | null => {
  try {
    return sha256OfFile(shimPath(clone)).slice(0, 12);
  } catch {
    return null;
  }
};

type ContainmentContext = { paths: IssueRuntimePaths; agent: string; issue: number };

/** The issue runtime this clone's agent belongs to, or null outside an automated issue. */
const containmentContext = (clone: string, issueValue: string | undefined): ContainmentContext | null => {
  const issue = Number(issueValue);
  if (!Number.isInteger(issue) || issue < 1) return null;
  const agent = localConfigGet(clone, "consensus.agentId");
  if (agent === null) return null;
  const { configPath } = resolveWorkspaceConfig(clone);
  const paths = issueRuntimePaths(workspaceLocationFromConfig(configPath).workspaceRoot, issue);
  if (!existsSync(paths.start) || !readStartState(paths).originalRoster.includes(agent)) return null;
  return { paths, agent, issue };
};

export type ShellGuardResult = { output: string; denied: boolean; recordError?: string };

/** The whole hook: read, decide, record a deny as evidence, and answer in the vendor's format. */
export const runShellGuard = (input: {
  vendor: LifecycleVendor;
  clone: string;
  raw: unknown;
  env: NodeJS.ProcessEnv;
  now?: string;
}): ShellGuardResult => {
  const clone = resolve(input.clone);
  const request = readShellRequest(input.vendor, input.raw);
  if (request === null) return { output: SHELL_GUARD_ALLOW[input.vendor], denied: false };
  const verdict = decideShellRequest({ clone, request, env: input.env });
  if (!verdict.deny) return { output: SHELL_GUARD_ALLOW[input.vendor], denied: false };
  const output = shellGuardDenyResponse(input.vendor, verdict.reason);
  // Evidence is best effort: failing to record a deny never turns it into an allow.
  try {
    const context = containmentContext(clone, input.env.COORD_ISSUE);
    const revision = policyRevision(clone);
    if (context !== null && revision !== null) {
      const now = input.now ?? new Date().toISOString();
      recordContainmentEvidence(
        context.paths,
        context.agent,
        { hookDenial: { sessionId: request.sessionId, vendorVersion: request.vendorVersion, policyRevision: revision, at: now } },
        now
      );
      appendJournal(
        context.paths,
        {
          type: "agent-lifecycle",
          agent: context.agent,
          details: {
            vendor: input.vendor,
            event: "shell-guard",
            kind: "containment-guard-denied",
            subcommand: verdict.subcommand,
            policyRevision: revision,
            ...(request.sessionId === null ? {} : { guardSessionId: request.sessionId }),
            ...(request.vendorVersion === null ? {} : { vendorVersion: request.vendorVersion })
          }
        },
        now
      );
    }
  } catch (error) {
    return { output, denied: true, recordError: error instanceof Error ? error.message : String(error) };
  }
  return { output, denied: true };
};

// ---------------------------------------------------------------------------

const resolveOnPath = (pathValue: string | undefined, cwd: string): string | null => {
  for (const entry of (pathValue ?? "").split(delimiter)) {
    if (entry === "") continue;
    const candidate = resolve(cwd, entry, "git");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
};

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export type ProbeResult = { lines: string[]; coverage: ContainmentCoverage | null };

/**
 * `coord containment-probe`, run by the agent through its own shell tool.
 * This process inherits exactly the environment that tool gives commands, so
 * its PATH is the one that decides whether `git` reaches the shim.
 *
 * With `refusalRan`, it is the tail of the expected-refusal probe: reaching it
 * at all means the harness ran a command its guard had denied.
 */
export const runContainmentProbe = (input: {
  clone: string;
  env: NodeJS.ProcessEnv;
  issue?: number;
  refusalRan?: boolean;
  now?: string;
}): ProbeResult => {
  const clone = resolve(input.clone);
  const context = containmentContext(clone, input.issue === undefined ? input.env.COORD_ISSUE : String(input.issue));
  if (context === null) {
    return {
      lines: ["coord containment-probe: no automated issue for this clone (pass --issue <n>); nothing recorded."],
      coverage: null
    };
  }
  const now = input.now ?? new Date().toISOString();
  const sessionId = readAgentLifecycle(context.paths).agents[context.agent]?.sessionId ?? null;
  if (input.refusalRan === true) {
    recordContainmentEvidence(context.paths, context.agent, { refusalRan: { sessionId, at: now } }, now);
    appendJournal(
      context.paths,
      { type: "agent-lifecycle", agent: context.agent, details: { event: "containment-probe", kind: "containment-refusal-ran" } },
      now
    );
    return {
      lines: ["coord containment-probe: the expected-refusal probe ran, so this harness did not enforce the shell-tool guard."],
      coverage: null
    };
  }
  const resolved = resolveOnPath(input.env.PATH, clone);
  const expected = realpathOrSelf(shimPath(clone));
  const issueEnv = input.env.COORD_ISSUE === String(context.issue);
  const delegateEnv = input.env.COORD_GIT_DELEGATE === "1";
  const shim =
    resolved !== null && realpathOrSelf(resolved) === expected && existsSync(expected) && issueEnv && !delegateEnv
      ? "active"
      : "bypassed";
  const revision = policyRevision(clone);
  const state = recordContainmentEvidence(
    context.paths,
    context.agent,
    { probe: { sessionId, shim, resolvedGit: resolved, issueEnv, delegateEnv, policyRevision: revision, at: now } },
    now
  );
  const entry = state.agents[context.agent];
  const coverage = entry === undefined ? null : containmentCoverage(entry);
  appendJournal(
    context.paths,
    {
      type: "agent-lifecycle",
      agent: context.agent,
      details: {
        event: "containment-probe",
        kind: "containment-probe",
        shim,
        hook: coverage?.hook ?? "unverified",
        issueEnv,
        delegateEnv,
        ...(revision === null ? {} : { policyRevision: revision })
      }
    },
    now
  );
  return {
    lines: [
      `coord containment-probe: git resolves to ${resolved ?? "(nothing)"}; expected ${expected}.`,
      `  shim=${shim} hook=${coverage?.hook ?? "unverified"}${issueEnv ? "" : " (COORD_ISSUE is not set in this shell)"}${delegateEnv ? " (COORD_GIT_DELEGATE=1 disables the shim)" : ""}`
    ],
    coverage
  };
};
