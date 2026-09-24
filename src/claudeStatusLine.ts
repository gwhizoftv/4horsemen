import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AGENT_LIFECYCLE_HOOK_MARKER,
  isObject,
  readDocument,
  shellQuote,
  type JsonObject
} from "./agentHookSync.js";
import { atomicWriteJson } from "./state.js";
import type { EffectOptions } from "./setupWorkspace.js";

/**
 * Claude statusline tee (#140). A clone-local override runs the owner's
 * effective statusline command on the original stdin bytes and hands coord a
 * bounded copy of the payload for `rate_limits` telemetry. It is installed only
 * where precedence is provable; anything else disables telemetry instead of
 * guessing, and Claude's other settings (including auto-continue) are never
 * touched.
 */

/** Bytes of each render forwarded to coord; the owner command always gets all of them. */
export const CLAUDE_STATUSLINE_TELEMETRY_BYTES = 65_536;
/** Lifetime of one telemetry receiver before it is killed and reaped. */
export const CLAUDE_STATUSLINE_RECEIVER_SECONDS = 5;

/** Managed settings outrank the clone-local layer; a statusLine there shadows the tee. */
export const DEFAULT_CLAUDE_MANAGED_SETTINGS = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json"
];

export const claudeStatusLinePaths = (clone: string) => {
  const root = join(resolve(clone), ".claude");
  return {
    root,
    local: join(root, "settings.local.json"),
    project: join(root, "settings.json"),
    wrapper: join(root, "coord-statusline.sh"),
    manifest: join(root, "coord-statusline.json"),
    lock: join(root, "coord-statusline.lock")
  };
};

type Manifest = {
  version: 1;
  marker: typeof AGENT_LIFECYCLE_HOOK_MARKER;
  /** Exact prior value of the clone-local layer, restored on removal. */
  hadStatusLine: boolean;
  previousStatusLine?: unknown;
};

export type ClaudeStatusLineContext = {
  clone: string;
  /** Owner home whose `~/.claude/settings.json` is the lowest layer; null skips it. */
  home: string | null;
  launcher?: string;
  managedSettings?: readonly string[];
};

export type EffectiveStatusLine =
  | { status: "resolved"; value: JsonObject | null; source: "local" | "project" | "user" | "none" }
  | { status: "ambiguous"; reason: string };

const commandOf = (value: unknown): string | null =>
  isObject(value) && typeof value.command === "string" && value.command.trim() !== "" ? value.command : null;

const readManifest = (path: string): Manifest | null => {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isObject(value) || value.version !== 1 || value.marker !== AGENT_LIFECYCLE_HOOK_MARKER || typeof value.hadStatusLine !== "boolean") {
      return null;
    }
    return {
      version: 1, marker: AGENT_LIFECYCLE_HOOK_MARKER, hadStatusLine: value.hadStatusLine,
      ...(Object.hasOwn(value, "previousStatusLine") ? { previousStatusLine: value.previousStatusLine } : {})
    };
  } catch {
    return null;
  }
};

const layer = (path: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: readDocument(path).statusLine };
  } catch {
    return { ok: false };
  }
};

/**
 * The command Claude would actually run without the tee. `localPrior` is the
 * clone-local value to consider (the manifest's recorded prior once installed).
 */
const resolveEffective = (
  context: ClaudeStatusLineContext,
  localPrior: { present: boolean; value: unknown }
): EffectiveStatusLine => {
  for (const path of context.managedSettings ?? DEFAULT_CLAUDE_MANAGED_SETTINGS) {
    if (!existsSync(path)) continue;
    const managed = layer(path);
    if (!managed.ok) return { status: "ambiguous", reason: `managed settings ${path} are unreadable` };
    if (managed.value !== undefined) return { status: "ambiguous", reason: `managed settings ${path} define statusLine` };
  }
  if (context.launcher !== undefined && existsSync(context.launcher) && /--settings\b/.test(readFileSync(context.launcher, "utf8"))) {
    return { status: "ambiguous", reason: "the launcher passes --settings, which outranks clone-local settings" };
  }
  const paths = claudeStatusLinePaths(context.clone);
  const candidates: { source: "local" | "project" | "user"; present: boolean; value: unknown }[] = [
    { source: "local", ...localPrior }
  ];
  for (const [source, path] of [["project", paths.project], ["user", context.home === null ? null : join(resolve(context.home), ".claude", "settings.json")]] as const) {
    if (path === null || !existsSync(path)) continue;
    const found = layer(path);
    if (!found.ok) return { status: "ambiguous", reason: `${path} is not a readable settings object` };
    candidates.push({ source, present: found.value !== undefined, value: found.value });
  }
  const effective = candidates.find((candidate) => candidate.present && candidate.value !== null);
  if (effective === undefined) return { status: "resolved", value: null, source: "none" };
  if (!isObject(effective.value) || (effective.value.type ?? "command") !== "command" || commandOf(effective.value) === null) {
    return { status: "ambiguous", reason: `the ${effective.source} statusLine is not a supported command` };
  }
  if (commandOf(effective.value) === paths.wrapper) return { status: "ambiguous", reason: "the tee would call itself" };
  return { status: "resolved", value: effective.value, source: effective.source };
};

export const renderClaudeStatusLineWrapper = (cliEntry: string, clone: string, downstream: string | null): string => {
  const paths = claudeStatusLinePaths(clone);
  const receiver = `/usr/bin/env node ${shellQuote(resolve(cliEntry))} agent-event --vendor claude --clone ${shellQuote(resolve(clone))} --event status-line`;
  const run = downstream === null ? ":" : `/bin/sh -c ${shellQuote(downstream)}`;
  return [
    "#!/bin/sh",
    `# ${AGENT_LIFECYCLE_HOOK_MARKER}`,
    "# Claude statusline tee: the owner command receives the original stdin bytes",
    "# and its own stdout/stderr/exit status; coord receives a bounded copy, one",
    "# receiver at a time, never waited on. With no owner command it prints nothing.",
    "set -u",
    `lock=${shellQuote(paths.lock)}`,
    "if ! tmp=$(mktemp \"${TMPDIR:-/tmp}/coord-claude-statusline.XXXXXX\" 2>/dev/null); then",
    downstream === null ? "  cat >/dev/null; exit 0" : `  exec ${run}`,
    "fi",
    "cat >\"$tmp\"",
    "if mkdir \"$lock\" 2>/dev/null; then",
    `  head -c ${CLAUDE_STATUSLINE_TELEMETRY_BYTES} "$tmp" >"$lock/payload" 2>/dev/null`,
    // The receiver lives at most the bound, is always reaped, and only its own
    // subshell releases the exclusion it holds.
    "  (",
    `    ${receiver} <"$lock/payload" & rpid=$!`,
    "    echo \"$rpid\" >\"$lock/pid\"",
    `    ( sleep ${CLAUDE_STATUSLINE_RECEIVER_SECONDS}; kill -9 "$rpid" ) & wpid=$!`,
    "    wait \"$rpid\"",
    "    kill \"$wpid\" 2>/dev/null",
    "    [ \"$(cat \"$lock/pid\" 2>/dev/null)\" = \"$rpid\" ] && rm -rf \"$lock\"",
    "  ) </dev/null >/dev/null 2>&1 &",
    // An abandoned exclusion is reused only once its recorded receiver is provably gone.
    "elif [ -n \"$(find \"$lock\" -maxdepth 0 -mmin +1 2>/dev/null)\" ] && ! kill -0 \"$(cat \"$lock/pid\" 2>/dev/null)\" 2>/dev/null; then",
    "  rm -rf \"$lock\"",
    "fi",
    `${run} <"$tmp"`,
    "status=$?",
    "rm -f \"$tmp\"",
    "exit $status",
    ""
  ].join("\n");
};

export type ClaudeStatusLineInspection =
  | { kind: "missing" | "current"; path: string }
  | { kind: "modified" | "disabled"; path: string; reason: string };

type Plan =
  | { kind: "install"; settings: JsonObject; manifest: Manifest; wrapper: string }
  | { kind: "current" }
  | { kind: "disabled"; reason: string };

const plan = (context: ClaudeStatusLineContext & { cliEntry: string }): Plan => {
  const paths = claudeStatusLinePaths(context.clone);
  const settings = readDocument(paths.local);
  const manifest = readManifest(paths.manifest);
  if (existsSync(paths.manifest) && manifest === null) {
    return { kind: "disabled", reason: `${paths.manifest} is not a valid coordinator manifest` };
  }
  const ours = commandOf(settings.statusLine) === paths.wrapper;
  if (manifest === null && ours) return { kind: "disabled", reason: `the prior status line cannot be restored because ${paths.manifest} is missing` };
  // The owner replaced the tee after installation: their edit wins, telemetry stays off.
  if (manifest !== null && !ours) return { kind: "disabled", reason: "the owner replaced the coordinator status line" };
  const ownership: Manifest = manifest ?? {
    version: 1, marker: AGENT_LIFECYCLE_HOOK_MARKER, hadStatusLine: Object.hasOwn(settings, "statusLine"),
    ...(Object.hasOwn(settings, "statusLine") ? { previousStatusLine: settings.statusLine } : {})
  };
  const effective = resolveEffective(context, { present: ownership.hadStatusLine, value: ownership.previousStatusLine });
  if (effective.status === "ambiguous") return { kind: "disabled", reason: effective.reason };
  const plannedSettings = { ...settings, statusLine: { ...(effective.value ?? {}), type: "command", command: paths.wrapper } };
  const wrapper = renderClaudeStatusLineWrapper(context.cliEntry, context.clone, commandOf(effective.value));
  const current = manifest !== null &&
    JSON.stringify(settings) === JSON.stringify(plannedSettings) &&
    existsSync(paths.wrapper) && readFileSync(paths.wrapper, "utf8") === wrapper;
  return current ? { kind: "current" } : { kind: "install", settings: plannedSettings, manifest: ownership, wrapper };
};

export const syncClaudeStatusLine = (
  input: ClaudeStatusLineContext & { cliEntry: string; options: EffectOptions }
): { changed: boolean; disabled: string | null } => {
  const paths = claudeStatusLinePaths(input.clone);
  const planned = plan(input);
  if (planned.kind === "current") return { changed: false, disabled: null };
  if (planned.kind === "disabled") {
    input.options.log(`Claude status-line telemetry disabled in ${input.clone}: ${planned.reason}\n`);
    return { changed: false, disabled: planned.reason };
  }
  input.options.changes.push(`install Claude status-line tee in ${input.clone}`);
  input.options.log(`${input.options.dryRun ? "would install" : "installed"} Claude status-line tee at ${paths.wrapper}\n`);
  if (!input.options.dryRun) {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    writeFileSync(paths.wrapper, planned.wrapper, { mode: 0o700 });
    chmodSync(paths.wrapper, 0o700);
    atomicWriteJson(resolve(input.clone), paths.manifest, planned.manifest);
    atomicWriteJson(resolve(input.clone), paths.local, planned.settings);
  }
  return { changed: true, disabled: null };
};

/** Restore the clone-local prior value only while the tee is still ours. */
export const removeClaudeStatusLine = (input: { clone: string; options: EffectOptions }): { changed: boolean; kept: boolean } => {
  const paths = claudeStatusLinePaths(input.clone);
  const manifest = readManifest(paths.manifest);
  if (manifest === null) return { changed: false, kept: existsSync(paths.manifest) };
  const settings = existsSync(paths.local) ? readDocument(paths.local) : {};
  if (commandOf(settings.statusLine) !== paths.wrapper) return { changed: false, kept: true };
  const planned: JsonObject = { ...settings };
  if (manifest.hadStatusLine) planned.statusLine = manifest.previousStatusLine;
  else delete planned.statusLine;
  input.options.changes.push(`remove Claude status-line tee from ${input.clone}`);
  input.options.log(`${input.options.dryRun ? "would remove" : "removed"} Claude status-line tee from ${paths.local}\n`);
  if (!input.options.dryRun) {
    if (Object.keys(planned).length === 0) rmSync(paths.local, { force: true });
    else atomicWriteJson(resolve(input.clone), paths.local, planned);
    rmSync(paths.wrapper, { force: true });
    rmSync(paths.manifest, { force: true });
    rmSync(paths.lock, { recursive: true, force: true });
  }
  return { changed: true, kept: false };
};

/** Read-only: never probes, mutates, or prints the owner's command. */
export const inspectClaudeStatusLine = (input: ClaudeStatusLineContext & { cliEntry: string }): ClaudeStatusLineInspection => {
  const paths = claudeStatusLinePaths(input.clone);
  let planned: Plan;
  try {
    planned = plan(input);
  } catch (error) {
    return { kind: "disabled", path: paths.local, reason: error instanceof Error ? error.message : String(error) };
  }
  if (planned.kind === "current") return { kind: "current", path: paths.local };
  if (planned.kind === "disabled") return { kind: "disabled", path: paths.local, reason: planned.reason };
  return readManifest(paths.manifest) === null
    ? { kind: "missing", path: paths.local }
    : { kind: "modified", path: paths.local, reason: "the owner's effective status line changed since installation" };
};
