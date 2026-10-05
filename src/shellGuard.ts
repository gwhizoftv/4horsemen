import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { object, stringField, type LifecycleVendor } from "./agentEvent.js";
import { agentLifecycleHookPath } from "./agentHookSync.js";
import { containmentCoverage, containmentSchema, readAgentLifecycle, recordContainmentEvidence } from "./agentLifecycle.js";
import { localConfigGet } from "./gitExec.js";
import { sha256 } from "./hash.js";
import { resolveWorkspaceConfig } from "./hookPolicy.js";
import { assertNoSymlink, issueRuntimePaths, type IssueRuntimePaths } from "./paths.js";
import { GIT_WRAPPER_RELATIVE_PATH } from "./setupWorkspace.js";
import { appendJournal, atomicWriteJson, readStartState } from "./state.js";
import { workspaceLocationFromConfig } from "./workspace.js";

// Increment when recognition or response semantics change. Configuration and
// shim bytes also participate, so an install/reconfiguration invalidates probes.
const GUARD_REVISION = "shell-guard-v1";
// The tool sandbox can write its clone, not the owner's lifecycle/journal.
// This bounded, advisory mailbox uses the already-ignored managed directory.
const probeMailbox = (clone: string) => join(clone, ".coord", "containment-observation.json");
export const containmentPolicy = (clone: string, vendor: string): { policyRevision: string; binding: string } | null => {
  try {
    const shim = readFileSync(join(clone, GIT_WRAPPER_RELATIVE_PATH));
    const path = agentLifecycleHookPath(clone, vendor);
    if (!path) return null;
    return { policyRevision: sha256(shim).slice(0, 12), binding: sha256(`${GUARD_REVISION}\n${sha256(shim)}\n${readFileSync(path, "utf8")}`) };
  } catch { return null; }
};

export const shellGuardResponse = (vendor: LifecycleVendor, reason?: string): Record<string, unknown> => {
  if (vendor === "cursor") return reason === undefined ? { permission: "allow" }
    : { permission: "deny", user_message: reason, agent_message: reason };
  if (vendor === "antigravity") return reason === undefined ? { decision: "allow" } : { decision: "deny", reason };
  return reason === undefined ? {} : { hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason
  } };
};

export const normalizeShellRequest = (vendor: LifecycleVendor, value: unknown, clone: string) => {
  const raw = object(value);
  if (!raw) return null;
  const tool = object(raw.tool_input) ?? {};
  const args = object(object(raw.toolCall)?.args) ?? {};
  const command: unknown = vendor === "cursor" ? raw.command : vendor === "antigravity" ? args.CommandLine : tool.command;
  if (typeof command !== "string" && !(Array.isArray(command) && command.every((part) => typeof part === "string"))) return null;
  return {
    command: command as string | string[],
    cwd: stringField(args, "Cwd") ?? stringField(tool, "cwd") ?? stringField(raw, "cwd") ?? clone,
    sessionId: stringField(raw, "session_id", "conversation_id", "conversationId") ?? null,
    vendorVersion: stringField(raw, "cursor_version", "version", "cli_version") ?? "unknown"
  };
};

type Word = { text: string; literal: boolean; operator?: boolean };
type GitCall = { argv: string[]; cwd: string; env: NodeJS.ProcessEnv };

/** Deliberately not an interpreter. Expansions, functions, scripts, eval and
 * later terminal input are outside the guarantee. No candidate text is run. */
const lex = (source: string): Word[] => {
  if (source.length > 131072) return [];
  const words: Word[] = [];
  let text = "", started = false, literal = true, quote = "";
  const flush = () => {
    if (started) words.push({ text, literal });
    text = ""; started = false; literal = true;
  };
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  let heredoc: boolean | null = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;
    if (quote === "'") {
      if (char === "'") quote = ""; else text += char;
      continue;
    }
    if (char === "\\") {
      const next = source[++i];
      if (next === undefined) return [];
      if (next !== "\n") {
        if (quote === '"' && !['$', '`', '"', "\\"].includes(next)) text += "\\";
        text += next; started = true;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else { text += char; if (char === "$" || char === "`") literal = false; }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "#" && !started) {
      while (i < source.length && source[i] !== "\n") i++;
      i--; continue;
    }
    if (/\s/.test(char) || ";&|()< >".includes(char)) {
      flush();
      if (heredoc !== null && words.at(-1)?.operator !== true) {
        const delimiter = words.at(-1);
        if (!delimiter?.literal) return [];
        heredocs.push({ delimiter: delimiter.text, tabs: heredoc }); heredoc = null;
      }
      if (char === "\n") {
        words.push({ text: ";", literal: true, operator: true });
        for (const doc of heredocs.splice(0)) {
          let found = false;
          while (++i < source.length) {
            const end = source.indexOf("\n", i);
            const line = source.slice(i, end < 0 ? source.length : end);
            i = end < 0 ? source.length : end;
            if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) { found = true; break; }
          }
          if (!found) return [];
        }
      } else if (!/\s/.test(char)) {
        let op = char;
        if (["&&", "||", "|&", ">>", "<<", "<&", ">&", "<>"].includes(char + source[i + 1])) op += source[++i];
        if (op === "<<" && source[i + 1] === "-") { op += "-"; i++; }
        if (op === "<<" || op === "<<-") heredoc = op === "<<-";
        words.push({ text: op, literal: true, operator: true });
      }
    } else {
      started = true; text += char;
      if (char === "$" || char === "`") literal = false;
    }
    if (words.length > 8192) return [];
  }
  if (quote || heredocs.length) return [];
  flush();
  return words;
};

export const staticGitCalls = (command: string | string[], cwd: string, environment: NodeJS.ProcessEnv): GitCall[] => {
  const calls: GitCall[] = [];
  let budget = 256;
  const visit = (input: string | string[], initialCwd: string, initialEnv: NodeJS.ProcessEnv, depth: number): void => {
    if (depth > 4 || --budget < 0) return;
    const tokens = typeof input === "string" ? lex(input) : input.map((text) => ({ text, literal: true }));
    let dir: string | null = initialCwd;
    let env = { ...initialEnv };
    const stack: { dir: string | null; env: NodeJS.ProcessEnv }[] = [];
    let segment: Word[] = [];
    let pipeline = false;
    const consume = (isolated = false) => {
      if (--budget < 0 || !dir || segment.length === 0) { segment = []; return; }
      const words = segment; segment = [];
      let n = 0;
      const local = { ...env };
      const assignments = () => {
        while (words[n]?.literal && /^[A-Za-z_][A-Za-z_0-9]*=/.test(words[n]?.text ?? "")) {
          const word = (words[n++] as Word).text, equals = word.indexOf("=");
          const key = word.slice(0, equals);
          // Process identity is coordinator-owned; only Git targeting affects policy.
          if (key === "GIT_DIR" || key === "GIT_WORK_TREE") local[key] = word.slice(equals + 1);
        }
      };
      assignments();
      if (n === words.length) { if (!isolated) env = local; return; }
      while (words[n]?.literal && ["env", "command", "exec", "nohup", "time"].includes(basename(words[n]?.text ?? ""))) {
        const wrapper = basename((words[n++] as Word).text);
        while (words[n]?.text.startsWith("-")) {
          const option = (words[n++] as Word).text;
          if (option === "--") break;
          if (wrapper === "env" && (option === "-u" || option === "--unset")) {
            const key = words[n++]?.text;
            if (key === "GIT_DIR" || key === "GIT_WORK_TREE") delete local[key];
          } else if (!["-i", "--ignore-environment", "-p"].includes(option)) return;
        }
        assignments();
      }
      const head = words[n++];
      if (!head?.literal) return;
      const args = words.slice(n);
      const name = basename(head.text);
      if (["{", "if", "for", "while", "until", "case", "function", "select"].includes(name)) {
        dir = null; // Unsupported control flow: do not misattribute a later cwd.
        return;
      }
      if (name === "cd" || name === "pushd") {
        if (isolated) return;
        const target = args[0]?.text === "--" ? args[1] : args[0];
        try { dir = target?.literal ? realpathSync(resolve(dir, target.text)) : null;
          if (dir && !statSync(dir).isDirectory()) dir = null;
        } catch { dir = null; }
        return;
      }
      if (["sh", "bash", "zsh", "dash"].includes(name)) {
        let index = 0;
        while (args[index]?.literal && /^-[a-zA-Z]+$/.test(args[index]?.text ?? "")) {
          if (args[index]?.text.includes("c")) {
            const script = args[index + 1];
            if (script?.literal) visit(script.text, dir, local, depth + 1);
            return;
          }
          index++;
        }
      }
      if (name === "git" && args.every((word) => word.literal) && calls.length < 64) {
        calls.push({ argv: args.map((word) => word.text), cwd: dir, env: local });
      }
    };
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as Word;
      if (!token.operator) { segment.push(token); continue; }
      if (/^[<>]/.test(token.text)) {
        if (/^\d+$/.test(segment.at(-1)?.text ?? "")) segment.pop();
        i++; // redirection target / heredoc delimiter is data
      } else if (token.text === "(") {
        consume(); stack.push({ dir, env: { ...env } });
      } else if (token.text === ")") {
        consume(); const parent = stack.pop();
        if (parent) { dir = parent.dir; env = parent.env; }
      } else {
        const pipe = token.text === "|" || token.text === "|&";
        consume(pipeline || pipe || token.text === "&");
        pipeline = pipe;
      }
    }
    consume(pipeline);
  };
  visit(command, cwd, environment, 0);
  return calls;
};

const runtimeFor = (clone: string, environment: NodeJS.ProcessEnv, explicitIssue?: number) => {
  const issue = explicitIssue ?? Number(environment.COORD_ISSUE);
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error("no automated issue environment");
  const agent = localConfigGet(clone, "consensus.agentId");
  if (!agent) throw new Error("clone has no agent identity");
  const { configPath } = resolveWorkspaceConfig(clone);
  const paths = issueRuntimePaths(workspaceLocationFromConfig(configPath).workspaceRoot, issue);
  if (!readStartState(paths).originalRoster.includes(agent)) throw new Error("agent is not in this issue");
  return { paths, agent };
};

export const guardShellRequest = (input: {
  vendor: LifecycleVendor; clone: string; raw: unknown; env: NodeJS.ProcessEnv; warn?: (message: string) => void;
}): Record<string, unknown> => {
  const request = normalizeShellRequest(input.vendor, input.raw, input.clone);
  if (!request || !/^[1-9][0-9]*$/.test(input.env.COORD_ISSUE ?? "")) return shellGuardResponse(input.vendor);
  const deadline = Date.now() + 5000;
  for (const call of staticGitCalls(request.command, request.cwd, input.env)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { input.warn?.("policy check budget exhausted; coverage is unverified"); break; }
    const env: NodeJS.ProcessEnv = { ...call.env, PWD: call.cwd, COORD_GIT_POLICY_CHECK: "1" };
    delete env.COORD_GIT_DELEGATE;
    const result = spawnSync(join(input.clone, GIT_WRAPPER_RELATIVE_PATH), call.argv, {
      cwd: call.cwd, env, encoding: "utf8", timeout: Math.min(1500, remaining), maxBuffer: 16384
    });
    if (result.status !== 2) {
      if (result.error || result.status !== 0) input.warn?.("policy check unavailable; coverage is unverified");
      continue;
    }
    const reason = `${result.stderr.trim()}\nUse the action's Bound input files when provided.`;
    // Recording is best effort, and MUST NOT turn a valid deny into allow.
    try {
      const { paths, agent } = runtimeFor(input.clone, input.env);
      const policy = containmentPolicy(input.clone, input.vendor);
      if (policy && request.sessionId) {
        const at = new Date().toISOString();
        const probe = call.argv.join(" ") === "status --porcelain" && resolve(call.cwd) === resolve(input.clone);
        if (probe) recordContainmentEvidence(paths, agent, { hookDenial: { ...policy, sessionId: request.sessionId, probe, at } }, at);
        appendJournal(paths, { type: "agent-lifecycle", agent, details: {
          kind: "containment-guard-denied", vendor: input.vendor, sessionId: request.sessionId,
          vendorVersion: request.vendorVersion, ...policy, probe,
          subcommand: /'git (status|diff|show)'/.exec(result.stderr)?.[1] ?? "unknown"
        } }, at);
      }
    } catch { input.warn?.("denial could not be recorded; do not infer verified coverage"); }
    return shellGuardResponse(input.vendor, reason);
  }
  return shellGuardResponse(input.vendor);
};

/** Both resolution and behavior come from the actual tool, not a new shell
 * spawned by coord. Installation and a deny callback alone prove neither. */
export const recordContainmentProbe = (input: {
  clone: string; env: NodeJS.ProcessEnv; issue?: number; resolvedGit: string;
  toolResult: "hook-denied" | "shim-refused" | "executed" | "unknown"; vendorVersion: string;
}) => {
  const { paths, agent } = runtimeFor(input.clone, input.env, input.issue);
  const entry = readAgentLifecycle(paths).agents[agent];
  const policy = containmentPolicy(input.clone, agent);
  if (!entry?.sessionId || !policy) throw new Error("session or installed policy unknown; containment remains unverified");
  const issueEnv = input.env.COORD_ISSUE === String(readStartState(paths).issue);
  const resolvesShim = issueEnv && input.env.COORD_GIT_DELEGATE !== "1" && resolve(input.clone, input.resolvedGit) === join(resolve(input.clone), GIT_WRAPPER_RELATIVE_PATH);
  const shim = !resolvesShim || input.toolResult === "executed" ? "bypassed"
    : input.toolResult === "shim-refused" ? "active" : "unverified";
  const at = new Date().toISOString();
  const probe = { ...policy, sessionId: entry.sessionId, vendorVersion: input.vendorVersion,
    resolvedGit: input.resolvedGit, issueEnv, shim, toolResult: input.toolResult, at } as const;
  // Validate before publishing; never require broader sandbox write grants.
  const validated = containmentSchema.parse({ hookDenial: null, probe }).probe;
  const start = readStartState(paths);
  atomicWriteJson(input.clone, probeMailbox(input.clone), { issueSessionId: start.issueSessionId, agent, probe: validated });
  const coverage = containmentCoverage({ ...entry, containment: { hookDenial: entry.containment?.hookDenial ?? null, probe } }, policy.binding);
  return { ...coverage, ...policy, sessionId: entry.sessionId, vendorVersion: input.vendorVersion, at, pending: true };
};

/** Coordinator-owned ingestion. Agent observations never authorize workflow
 * work. Replays, stale sessions/configs, oversized files and symlinks are inert. */
export const ingestContainmentProbe = (paths: IssueRuntimePaths, clone: string, agent: string): void => {
  const path = probeMailbox(clone);
  if (!existsSync(path)) return;
  try {
    assertNoSymlink(clone, path);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 16384) return;
    const raw = object(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (!raw || raw.agent !== agent || raw.issueSessionId !== readStartState(paths).issueSessionId) return;
    const probe = containmentSchema.parse({ hookDenial: null, probe: raw.probe }).probe;
    const entry = readAgentLifecycle(paths).agents[agent];
    if (!probe || probe.sessionId !== entry?.sessionId || probe.at <= (entry.containment?.probe?.at ?? "") ||
      Date.parse(probe.at) > Date.now() + 60_000 || probe.binding !== containmentPolicy(clone, agent)?.binding) return;
    const state = recordContainmentEvidence(paths, agent, { probe });
    const coverage = containmentCoverage(state.agents[agent], probe.binding);
    appendJournal(paths, { type: "agent-lifecycle", agent, details: {
      kind: "containment-coverage", ...probe, ...coverage, evidence: "agent-reported tool result",
      eventId: `containment-probe:${agent}:${probe.sessionId}:${probe.binding}:${probe.at}`
    } });
  } catch { /* Advisory telemetry must not stop the workflow. */ }
};
