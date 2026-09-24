import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_LIFECYCLE_HOOK_MARKER } from "./agentHookSync.js";
import { atomicWriteJson } from "./state.js";
import type { EffectOptions } from "./setupWorkspace.js";

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readDocument = (path: string): JsonObject => {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const statusLineCommand = (value: unknown): string | null =>
  isObject(value) && typeof value.command === "string" && value.command !== "" ? value.command : null;

export type ClaudeStatusLinePaths = {
  clone: string;
  settingsLocal: string;
  settingsProject: string;
  settingsUser: string;
  wrapper: string;
  manifest: string;
};

export const claudeStatusLinePaths = (clone: string, home = homedir()): ClaudeStatusLinePaths => {
  const claudeDir = join(resolve(clone), ".claude");
  return {
    clone: resolve(clone),
    settingsLocal: join(claudeDir, "settings.local.json"),
    settingsProject: join(claudeDir, "settings.json"),
    settingsUser: join(resolve(home), ".claude", "settings.json"),
    wrapper: join(claudeDir, "coord-statusline.sh"),
    manifest: join(claudeDir, "coord-statusline.json")
  };
};

type ClaudeStatusLineManifest = {
  version: 1;
  marker: typeof AGENT_LIFECYCLE_HOOK_MARKER;
  hadStatusLine: boolean;
  previousStatusLine?: unknown;
  effectiveCommand: string | null;
  targetLayer: "local";
  disabledReason?: string;
};

const readManifest = (path: string): ClaudeStatusLineManifest | null => {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !isObject(value) ||
      value.version !== 1 ||
      value.marker !== AGENT_LIFECYCLE_HOOK_MARKER ||
      typeof value.hadStatusLine !== "boolean" ||
      value.targetLayer !== "local"
    ) {
      return null;
    }
    return value as ClaudeStatusLineManifest;
  } catch {
    return null;
  }
};

/**
 * Resolve owner effective statusline when clone-local override can win.
 * Managed/CLI ambiguity → disabled (no guessed replacement).
 */
export const resolveClaudeStatusLineEffective = (
  paths: ClaudeStatusLinePaths
): {
  command: string | null;
  priorLocal: unknown;
  hadLocal: boolean;
  ambiguous: boolean;
  reason?: string;
} => {
  const local = readDocument(paths.settingsLocal);
  const project = readDocument(paths.settingsProject);
  const user = readDocument(paths.settingsUser);

  // Heuristic: CLAUDE_CODE_SETTINGS / managed files are out of scope; if
  // settings.local already holds a non-coord command we treat it as owner.
  const localCmd = statusLineCommand(local.statusLine);
  if (localCmd !== null && localCmd.includes(AGENT_LIFECYCLE_HOOK_MARKER)) {
    // Already our wrapper — effective is whatever manifest recorded.
    const manifest = readManifest(paths.manifest);
    return {
      command: manifest?.effectiveCommand ?? null,
      priorLocal: manifest?.hadStatusLine === true ? manifest.previousStatusLine : undefined,
      hadLocal: manifest?.hadStatusLine ?? false,
      ambiguous: false
    };
  }
  if (localCmd !== null) {
    return { command: localCmd, priorLocal: local.statusLine, hadLocal: true, ambiguous: false };
  }
  const projectCmd = statusLineCommand(project.statusLine);
  if (projectCmd !== null) {
    return { command: projectCmd, priorLocal: undefined, hadLocal: false, ambiguous: false };
  }
  const userCmd = statusLineCommand(user.statusLine);
  if (userCmd !== null) {
    return { command: userCmd, priorLocal: undefined, hadLocal: false, ambiguous: false };
  }
  return { command: null, priorLocal: undefined, hadLocal: false, ambiguous: false };
};

/**
 * Byte-exact tee: `tee` duplicates stdin to the async receiver and downstream
 * without `$(cat)`, preserving trailing newlines. No invented display when
 * there is no owner command.
 */
export const renderClaudeStatusLineWrapper = (
  cliEntry: string,
  clone: string,
  downstreamCommand: string | null
): string => {
  const receiver = `/usr/bin/env node ${shellQuote(resolve(cliEntry))} agent-event --vendor claude --event status-line --clone ${shellQuote(resolve(clone))}`;
  const lines = [
    "#!/usr/bin/env bash",
    `# ${AGENT_LIFECYCLE_HOOK_MARKER}`,
    "set -eu",
    // Bound async receiver: one background copy; failures never block owner output.
    `recv() { ${receiver} >/dev/null 2>&1 || true; }`,
    ...(downstreamCommand === null
      ? [
          // No owner command: discard display; still forward a bounded telemetry copy.
          "tee >(recv) >/dev/null"
        ]
      : [`tee >(recv) | /bin/sh -c ${shellQuote(downstreamCommand)}`]),
    ""
  ];
  return lines.join("\n");
};

export type ClaudeStatusLineSyncResult = {
  changed: boolean;
  installed: boolean;
  disabledReason?: string;
  settingsPath: string;
};

export const syncClaudeStatusLine = (input: {
  clone: string;
  cliEntry: string;
  home?: string;
  options: EffectOptions;
}): ClaudeStatusLineSyncResult => {
  const paths = claudeStatusLinePaths(input.clone, input.home);
  const resolved = resolveClaudeStatusLineEffective(paths);
  if (resolved.ambiguous) {
    return {
      changed: false,
      installed: false,
      disabledReason: resolved.reason ?? "ambiguous-statusline-precedence",
      settingsPath: paths.settingsLocal
    };
  }

  const ownership: ClaudeStatusLineManifest = {
    version: 1,
    marker: AGENT_LIFECYCLE_HOOK_MARKER,
    hadStatusLine: resolved.hadLocal,
    ...(resolved.priorLocal !== undefined ? { previousStatusLine: resolved.priorLocal } : {}),
    effectiveCommand: resolved.command,
    targetLayer: "local"
  };

  const priorObject = isObject(resolved.priorLocal) ? resolved.priorLocal : {};
  const plannedStatusLine = {
    ...priorObject,
    command: paths.wrapper,
    ...(typeof priorObject.padding === "number" ? { padding: priorObject.padding } : {})
  };
  const local = readDocument(paths.settingsLocal);
  const plannedSettings = { ...local, statusLine: plannedStatusLine };
  const wrapper = renderClaudeStatusLineWrapper(input.cliEntry, paths.clone, resolved.command);

  const existingManifest = readManifest(paths.manifest);
  const unchanged =
    existingManifest !== null &&
    existsSync(paths.wrapper) &&
    readFileSync(paths.wrapper, "utf8") === wrapper &&
    JSON.stringify(local.statusLine) === JSON.stringify(plannedStatusLine);

  if (unchanged) {
    return { changed: false, installed: true, settingsPath: paths.settingsLocal };
  }

  if (input.options.dryRun === true) {
    return { changed: true, installed: true, settingsPath: paths.settingsLocal };
  }

  mkdirSync(dirname(paths.wrapper), { recursive: true, mode: 0o700 });
  writeFileSync(paths.wrapper, wrapper, { mode: 0o700 });
  chmodSync(paths.wrapper, 0o700);
  atomicWriteJson(paths.clone, paths.manifest, ownership);
  atomicWriteJson(paths.clone, paths.settingsLocal, plannedSettings);
  return { changed: true, installed: true, settingsPath: paths.settingsLocal };
};

export const removeClaudeStatusLine = (input: {
  clone: string;
  home?: string;
  options: EffectOptions;
}): { changed: boolean; kept: boolean } => {
  const paths = claudeStatusLinePaths(input.clone, input.home);
  const manifest = readManifest(paths.manifest);
  if (manifest === null) return { changed: false, kept: false };
  const settings = readDocument(paths.settingsLocal);
  const currentCmd = statusLineCommand(settings.statusLine);
  if (currentCmd !== paths.wrapper) {
    return { changed: false, kept: true };
  }
  if (existsSync(paths.wrapper)) {
    const body = readFileSync(paths.wrapper, "utf8");
    if (!body.includes(AGENT_LIFECYCLE_HOOK_MARKER)) {
      return { changed: false, kept: true };
    }
  }
  if (input.options.dryRun === true) return { changed: true, kept: false };

  const planned = { ...settings };
  if (manifest.hadStatusLine) planned.statusLine = manifest.previousStatusLine;
  else delete planned.statusLine;
  atomicWriteJson(paths.clone, paths.settingsLocal, planned);
  if (existsSync(paths.wrapper)) rmSync(paths.wrapper, { force: true });
  if (existsSync(paths.manifest)) rmSync(paths.manifest, { force: true });
  return { changed: true, kept: false };
};

export const inspectClaudeStatusLine = (
  clone: string,
  home?: string
): { kind: "current" | "missing" | "modified" | "disabled"; path: string; detail?: string } => {
  const paths = claudeStatusLinePaths(clone, home);
  const manifest = readManifest(paths.manifest);
  if (manifest === null) {
    return { kind: "missing", path: paths.settingsLocal };
  }
  if (manifest.disabledReason !== undefined) {
    return { kind: "disabled", path: paths.settingsLocal, detail: manifest.disabledReason };
  }
  const settings = readDocument(paths.settingsLocal);
  if (statusLineCommand(settings.statusLine) !== paths.wrapper) {
    return { kind: "modified", path: paths.settingsLocal };
  }
  const resolved = resolveClaudeStatusLineEffective(paths);
  if (resolved.command !== manifest.effectiveCommand) {
    return { kind: "modified", path: paths.settingsLocal, detail: "effective-command-drift" };
  }
  return { kind: "current", path: paths.settingsLocal };
};
