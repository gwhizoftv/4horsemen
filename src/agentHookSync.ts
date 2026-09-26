import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson } from "./state.js";
import type { EffectOptions } from "./setupWorkspace.js";
import type { LifecycleVendor } from "./agentEvent.js";

export const AGENT_LIFECYCLE_HOOK_MARKER = "coord-managed-agent-lifecycle-v1";
const ANTIGRAVITY_HOOK_NAME = "coord-agent-lifecycle";

const vendorForAgent = (agent: string): LifecycleVendor | null =>
  agent === "codex" || agent === "claude" || agent === "cursor" || agent === "antigravity" ? agent : null;

export const agentLifecycleHookPath = (clone: string, agent: string): string | null => {
  switch (vendorForAgent(agent)) {
    case "codex":
      return join(clone, ".codex", "hooks.json");
    case "claude":
      // Local settings are explicitly non-shareable and do not dirty a product.
      return join(clone, ".claude", "settings.local.json");
    case "cursor":
      return join(clone, ".cursor", "hooks.json");
    case "antigravity":
      return join(clone, ".agents", "hooks.json");
    default:
      return null;
  }
};

export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const renderAgentLifecycleHookCommand = (
  cliEntry: string,
  clone: string,
  vendor: LifecycleVendor,
  event: string
): string =>
  `COORD_AGENT_LIFECYCLE_HOOK=${AGENT_LIFECYCLE_HOOK_MARKER} /usr/bin/env node ${shellQuote(
    resolve(cliEntry)
  )} agent-event --vendor ${vendor} --clone ${shellQuote(resolve(clone))} --event ${shellQuote(event)}`;

export type JsonObject = Record<string, unknown>;
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const readDocument = (path: string): JsonObject => {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot install lifecycle hooks into invalid JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) throw new Error(`Cannot install lifecycle hooks into non-object JSON ${path}.`);
  return parsed;
};

const hooksObject = (document: JsonObject, path: string): JsonObject => {
  const hooks = document.hooks;
  if (hooks === undefined) return {};
  if (!isObject(hooks)) throw new Error(`Cannot install lifecycle hooks: ${path} has a non-object 'hooks' value.`);
  return hooks;
};

const commandOf = (value: unknown): string | null =>
  isObject(value) && typeof value.command === "string" ? value.command : null;

/** Remove only marked handlers, retaining owner handlers even in the same matcher group. */
const withoutManagedNestedHandlers = (value: unknown): { value: unknown | null; found: boolean } => {
  if (!isObject(value) || !Array.isArray(value.hooks)) return { value, found: false };
  let found = false;
  const hooks = value.hooks.filter((handler) => {
    const managed = commandOf(handler)?.includes(AGENT_LIFECYCLE_HOOK_MARKER) === true;
    if (managed) found = true;
    return !managed;
  });
  return { value: hooks.length === 0 ? null : { ...value, hooks }, found };
};

const eventArray = (hooks: JsonObject, event: string, path: string): unknown[] => {
  const current = hooks[event];
  if (current === undefined) return [];
  if (!Array.isArray(current)) throw new Error(`Cannot install lifecycle hooks: ${path} hook '${event}' is not an array.`);
  return current;
};

const nestedEvents: Record<"codex" | "claude", readonly string[]> = {
  codex: ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"],
  claude: ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]
};

/** Lifecycle hooks that drive nudge delivery and idle detection. */
export const cursorLifecycleEvents = ["sessionStart", "beforeSubmitPrompt", "stop", "sessionEnd"] as const;
/** Analytics hooks: tool counts and optional per-turn token fields on stdin. */
export const cursorUsageEvents = ["postToolUse", "postToolUseFailure", "afterAgentResponse"] as const;
export const cursorManagedEvents = [...cursorLifecycleEvents, ...cursorUsageEvents] as const;
const cursorEvents = cursorManagedEvents;
const antigravityEvents = ["PreInvocation", "PostInvocation", "Stop"] as const;

const plannedDocument = (input: {
  path: string;
  clone: string;
  cliEntry: string;
  vendor: LifecycleVendor;
  existing: JsonObject;
}): JsonObject => {
  if (input.vendor === "codex" || input.vendor === "claude") {
    const hooks = { ...hooksObject(input.existing, input.path) };
    for (const event of nestedEvents[input.vendor]) {
      const existing = eventArray(hooks, event, input.path).flatMap((entry) => {
        const cleaned = withoutManagedNestedHandlers(entry);
        return cleaned.value === null ? [] : [cleaned.value];
      });
      hooks[event] = [
        ...existing,
        {
          hooks: [
            {
              type: "command",
              command: renderAgentLifecycleHookCommand(input.cliEntry, input.clone, input.vendor, event),
              timeout: 5
            }
          ]
        }
      ];
    }
    return { ...input.existing, hooks };
  }

  if (input.vendor === "cursor") {
    const hooks = { ...hooksObject(input.existing, input.path) };
    for (const event of cursorEvents) {
      const existing = eventArray(hooks, event, input.path).filter(
        (entry) => commandOf(entry)?.includes(AGENT_LIFECYCLE_HOOK_MARKER) !== true
      );
      hooks[event] = [
        ...existing,
        { command: renderAgentLifecycleHookCommand(input.cliEntry, input.clone, input.vendor, event) }
      ];
    }
    return { ...input.existing, version: input.existing.version ?? 1, hooks };
  }

  const prior = input.existing[ANTIGRAVITY_HOOK_NAME];
  const document = { ...input.existing };
  if (prior !== undefined && !JSON.stringify(prior).includes(AGENT_LIFECYCLE_HOOK_MARKER)) {
    throw new Error(`Cannot install lifecycle hooks: ${input.path} already defines '${ANTIGRAVITY_HOOK_NAME}'.`);
  }
  document[ANTIGRAVITY_HOOK_NAME] = Object.fromEntries(
    antigravityEvents.map((event) => [
      event,
      [
        {
          type: "command",
          command: renderAgentLifecycleHookCommand(input.cliEntry, input.clone, input.vendor, event),
          timeout: 5
        }
      ]
    ])
  );
  return document;
};

export type AgentHookSyncOutcome = {
  supported: boolean;
  path: string | null;
  changed: boolean;
};

export const syncAgentLifecycleHooks = (input: {
  clone: string;
  agent: string;
  cliEntry: string;
  options: EffectOptions;
}): AgentHookSyncOutcome => {
  const vendor = vendorForAgent(input.agent);
  const path = agentLifecycleHookPath(input.clone, input.agent);
  if (vendor === null || path === null) return { supported: false, path: null, changed: false };
  const existing = readDocument(path);
  const planned = plannedDocument({ path, clone: input.clone, cliEntry: input.cliEntry, vendor, existing });
  if (JSON.stringify(existing) === JSON.stringify(planned)) return { supported: true, path, changed: false };
  input.options.changes.push(`write ${vendor} lifecycle hooks in ${input.clone}`);
  input.options.log(`${input.options.dryRun ? "would write" : "wrote"} ${vendor} lifecycle hooks in ${path}\n`);
  if (!input.options.dryRun) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteJson(input.clone, path, planned);
  }
  return { supported: true, path, changed: true };
};

export type AgentHookRemovalOutcome = { path: string | null; changed: boolean; kept: boolean };

export const removeAgentLifecycleHooks = (input: {
  clone: string;
  agent: string;
  options: EffectOptions;
}): AgentHookRemovalOutcome => {
  const vendor = vendorForAgent(input.agent);
  const path = agentLifecycleHookPath(input.clone, input.agent);
  if (vendor === null || path === null || !existsSync(path)) return { path, changed: false, kept: false };
  const existing = readDocument(path);
  let next: JsonObject = { ...existing };
  let found = false;
  if (vendor === "codex" || vendor === "claude" || vendor === "cursor") {
    const hooks = { ...hooksObject(existing, path) };
    const events = vendor === "cursor" ? cursorEvents : nestedEvents[vendor];
    for (const event of events) {
      const values = eventArray(hooks, event, path);
      const kept = values.flatMap((entry) => {
        if (vendor === "cursor") {
          const managed = commandOf(entry)?.includes(AGENT_LIFECYCLE_HOOK_MARKER) === true;
          if (managed) found = true;
          return managed ? [] : [entry];
        }
        const cleaned = withoutManagedNestedHandlers(entry);
        if (cleaned.found) found = true;
        return cleaned.value === null ? [] : [cleaned.value];
      });
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (Object.keys(hooks).length === 0) delete next.hooks;
    else next.hooks = hooks;
    if (vendor === "cursor" && Object.keys(next).length === 1 && next.version === 1) next = {};
  } else {
    const value = next[ANTIGRAVITY_HOOK_NAME];
    if (value !== undefined && JSON.stringify(value).includes(AGENT_LIFECYCLE_HOOK_MARKER)) {
      found = true;
      delete next[ANTIGRAVITY_HOOK_NAME];
    }
  }
  if (!found) return { path, changed: false, kept: false };
  input.options.changes.push(`remove ${vendor} lifecycle hooks from ${input.clone}`);
  input.options.log(`${input.options.dryRun ? "would remove" : "removed"} ${vendor} lifecycle hooks from ${path}\n`);
  if (!input.options.dryRun) {
    if (Object.keys(next).length === 0) rmSync(path);
    else atomicWriteJson(input.clone, path, next);
  }
  return { path, changed: true, kept: false };
};

export type AgentHookInspection = { kind: "unsupported" | "missing" | "current" | "modified"; path: string | null };

export const inspectAgentLifecycleHooks = (input: {
  clone: string;
  agent: string;
  cliEntry: string;
}): AgentHookInspection => {
  const vendor = vendorForAgent(input.agent);
  const path = agentLifecycleHookPath(input.clone, input.agent);
  if (vendor === null || path === null) return { kind: "unsupported", path: null };
  if (!existsSync(path)) return { kind: "missing", path };
  let existing: JsonObject;
  try {
    existing = readDocument(path);
  } catch {
    return { kind: "modified", path };
  }
  try {
    const planned = plannedDocument({ path, clone: input.clone, cliEntry: input.cliEntry, vendor, existing });
    return JSON.stringify(planned) === JSON.stringify(existing)
      ? { kind: "current", path }
      : { kind: JSON.stringify(existing).includes(AGENT_LIFECYCLE_HOOK_MARKER) ? "modified" : "missing", path };
  } catch {
    return { kind: "modified", path };
  }
};

// Antigravity exposes queue depth only through its one user-global status-line
// command. The managed wrapper tees the payload to coord and then runs the
// owner's prior command so installation does not replace their display.
const statusLinePaths = (home: string) => {
  const root = join(resolve(home), ".gemini", "antigravity-cli");
  return {
    root,
    settings: join(root, "settings.json"),
    wrapper: join(root, "coord-agent-lifecycle-statusline.sh"),
    manifest: join(root, "coord-agent-lifecycle-statusline.json")
  };
};

type StatusLineManifest = {
  version: 1;
  marker: typeof AGENT_LIFECYCLE_HOOK_MARKER;
  hadStatusLine: boolean;
  previousStatusLine?: unknown;
};

const readStatusLineManifest = (path: string): StatusLineManifest | null => {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !isObject(value) ||
      value.version !== 1 ||
      value.marker !== AGENT_LIFECYCLE_HOOK_MARKER ||
      typeof value.hadStatusLine !== "boolean"
    ) {
      return null;
    }
    return {
      version: 1,
      marker: AGENT_LIFECYCLE_HOOK_MARKER,
      hadStatusLine: value.hadStatusLine,
      ...(Object.hasOwn(value, "previousStatusLine") ? { previousStatusLine: value.previousStatusLine } : {})
    };
  } catch {
    return null;
  }
};

const statusLineCommand = (value: unknown): string | null =>
  isObject(value) && typeof value.command === "string" ? value.command : null;

const renderStatusLineWrapper = (cliEntry: string, previousStatusLine: unknown): string => {
  const downstream = statusLineCommand(previousStatusLine);
  return [
    "#!/usr/bin/env bash",
    `# ${AGENT_LIFECYCLE_HOOK_MARKER}`,
    "set -u",
    "payload=\"$(cat)\"",
    // Status rendering must not wait for a cold Node process. The receiver is
    // observational and owns its own lock, so forwarding can finish async.
    `(printf '%s' "$payload" | /usr/bin/env node ${shellQuote(resolve(cliEntry))} agent-event --vendor antigravity --event status-line >/dev/null 2>&1) &`,
    ...(downstream === null
      ? ["printf '%s\\n' 'coord lifecycle'"]
      : [`printf '%s' "$payload" | /bin/sh -c ${shellQuote(downstream)}`]),
    ""
  ].join("\n");
};

export const syncAntigravityStatusLine = (input: {
  home: string;
  cliEntry: string;
  options: EffectOptions;
}): { changed: boolean; settingsPath: string } => {
  const paths = statusLinePaths(input.home);
  const settings = readDocument(paths.settings);
  const manifest = readStatusLineManifest(paths.manifest);
  if (existsSync(paths.manifest) && manifest === null) {
    throw new Error(`Cannot update invalid coordinator status-line manifest ${paths.manifest}.`);
  }
  if (manifest === null && statusLineCommand(settings.statusLine) === paths.wrapper) {
    throw new Error(`Cannot preserve the prior Antigravity status line because ${paths.manifest} is missing.`);
  }
  const ownership: StatusLineManifest =
    manifest ?? {
      version: 1,
      marker: AGENT_LIFECYCLE_HOOK_MARKER,
      hadStatusLine: Object.hasOwn(settings, "statusLine"),
      ...(Object.hasOwn(settings, "statusLine") ? { previousStatusLine: settings.statusLine } : {})
    };
  const priorObject = isObject(ownership.previousStatusLine) ? ownership.previousStatusLine : {};
  const plannedStatusLine = {
    ...priorObject,
    type: "command",
    command: paths.wrapper
  };
  const plannedSettings = { ...settings, statusLine: plannedStatusLine };
  const wrapper = renderStatusLineWrapper(input.cliEntry, ownership.previousStatusLine);
  const settingsCurrent = JSON.stringify(settings) === JSON.stringify(plannedSettings);
  const wrapperCurrent = existsSync(paths.wrapper) && readFileSync(paths.wrapper, "utf8") === wrapper;
  const manifestCurrent = manifest !== null;
  if (settingsCurrent && wrapperCurrent && manifestCurrent) return { changed: false, settingsPath: paths.settings };

  input.options.changes.push("install Antigravity lifecycle status-line multiplexer");
  input.options.log(
    `${input.options.dryRun ? "would install" : "installed"} Antigravity lifecycle status-line multiplexer at ${paths.wrapper}\n`
  );
  if (!input.options.dryRun) {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    writeFileSync(paths.wrapper, wrapper, { mode: 0o700 });
    chmodSync(paths.wrapper, 0o700);
    atomicWriteJson(resolve(input.home), paths.manifest, ownership);
    atomicWriteJson(resolve(input.home), paths.settings, plannedSettings);
  }
  return { changed: true, settingsPath: paths.settings };
};

export const removeAntigravityStatusLine = (input: {
  home: string;
  options: EffectOptions;
}): { changed: boolean; kept: boolean } => {
  const paths = statusLinePaths(input.home);
  const manifest = readStatusLineManifest(paths.manifest);
  if (manifest === null || !existsSync(paths.settings)) return { changed: false, kept: existsSync(paths.manifest) };
  const settings = readDocument(paths.settings);
  if (statusLineCommand(settings.statusLine) !== paths.wrapper) return { changed: false, kept: true };
  const planned = { ...settings };
  if (manifest.hadStatusLine) planned.statusLine = manifest.previousStatusLine;
  else delete planned.statusLine;
  input.options.changes.push("remove Antigravity lifecycle status-line multiplexer");
  input.options.log(
    `${input.options.dryRun ? "would remove" : "removed"} Antigravity lifecycle status-line multiplexer from ${paths.settings}\n`
  );
  if (!input.options.dryRun) {
    atomicWriteJson(resolve(input.home), paths.settings, planned);
    rmSync(paths.wrapper, { force: true });
    rmSync(paths.manifest, { force: true });
  }
  return { changed: true, kept: false };
};
