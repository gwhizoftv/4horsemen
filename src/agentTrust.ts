import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isObject, readDocument } from "./agentHookSync.js";
import { isPathInside } from "./paths.js";
import { atomicWriteJson } from "./state.js";
import type { EffectOptions } from "./setupWorkspace.js";

/** Change only the trust key in Codex's standard project tables. */
const trustCodexProject = (text: string, root: string): string => {
  const quoted = JSON.stringify(root);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const key = `${escape(quoted)}|${escape(`'${root}'`)}`;
  const header = new RegExp(`^\\s*\\[\\s*projects\\s*\\.\\s*(?:${key})\\s*\\]\\s*(?:#.*)?$`);
  const lines = text.split("\n");
  const index = lines.findIndex((line) => header.test(line));
  if (index < 0) {
    // Inline/dotted project definitions need a TOML-aware merge. Do not append
    // a competing table or replace an owner's configuration in that case.
    if (text.includes(quoted) || text.includes(`'${root}'`)) {
      throw new Error(`Cannot update Codex trust for ${root}: use a [projects.${quoted}] table.`);
    }
    return `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}\n[projects.${quoted}]\ntrust_level = "trusted"\n`;
  }
  let end = index + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  const keyIndex = lines.findIndex((line, i) => i > index && i < end && /^\s*trust_level\s*=/.test(line));
  if (keyIndex >= 0) {
    if (/^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/.test(lines[keyIndex]!)) return text;
    lines[keyIndex] = 'trust_level = "trusted"';
  } else lines.splice(index + 1, 0, 'trust_level = "trusted"');
  return lines.join("\n");
};

/** Persistent setup trust; launchers keep their existing permission/sandbox flags. */
export const syncAgentTrust = (input: {
  agent: string;
  productRoot: string;
  clone: string;
  /** Stable external roots whose future issue subdirectories Cursor will open. */
  additionalRoots?: readonly string[];
  /** An explicit home isolates tests/embedders from the owner's environment. */
  home?: string | null;
  env?: NodeJS.ProcessEnv;
  options: EffectOptions;
}): void => {
  if (input.home === null || !["claude", "codex", "cursor", "antigravity"].includes(input.agent)) return;
  const home = resolve(input.home ?? homedir());
  const env = input.env ?? (input.home === undefined ? process.env : {});
  const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
  const parent = dirname(canonical(input.productRoot));
  const clone = canonical(input.clone);
  const change = (path: string, effect: () => void) => {
    const description = `configure ${input.agent} folder trust in ${path}`;
    input.options.changes.push(description);
    input.options.log(`${input.options.dryRun ? "would " : ""}${description}\n`);
    if (!input.options.dryRun) effect();
  };
  const writeJson = (path: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      change(path, () => atomicWriteJson(dirname(path), path, after));
    }
  };
  switch (input.agent) {
    case "codex": {
      const path = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
      const before = existsSync(path) ? readFileSync(path, "utf8") : "";
      // Own-repository entries also ensure project-local config/hooks load.
      const after = [...new Set([parent, clone])].reduce(trustCodexProject, before);
      if (after !== before) change(path, () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, after, { mode: 0o600 });
      });
      break;
    }
    case "claude": {
      const path = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
      const before = readDocument(path);
      if (before.projects !== undefined && !isObject(before.projects)) throw new Error(`Invalid projects object in ${path}`);
      const projects = { ...before.projects as Record<string, unknown> | undefined };
      for (const root of new Set([parent, clone])) {
        const entry = projects[root];
        if (entry !== undefined && !isObject(entry)) throw new Error(`Invalid project ${root} in ${path}`);
        projects[root] = { ...entry as Record<string, unknown> | undefined, hasTrustDialogAccepted: true };
      }
      writeJson(path, before, { ...before, projects });
      break;
    }
    case "cursor": {
      // tmux's cwd is physical, while --add-dir may retain a /var or symlink
      // spelling. Both stable spellings must inherit trust for future issues.
      const roots = [...new Set([parent, clone, ...input.additionalRoots ?? []]
        .flatMap((root) => [resolve(root), canonical(root)]))];
      // Cursor refuses inherited trust from home, ancestors of home, and paths
      // shallower than three components. Keep exact clone/root markers there.
      const inherits = (root: string) => root.split(sep).filter(Boolean).length >= 3 &&
        !isPathInside(root, home) && !isPathInside(root, canonical(home));
      for (const root of roots.filter((root) => !roots.some((other) => other !== root && inherits(other) && isPathInside(other, root)))) {
        // Cursor 2026.10 uses DATA_DIR (not CONFIG_DIR) and this path encoding
        // for the same persistent marker written by its workspace-trust dialog.
        const key = root.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
        const path = join(env.CURSOR_DATA_DIR || join(home, ".cursor"), "projects", key, ".workspace-trusted");
        if (!existsSync(path)) change(path, () => atomicWriteJson(dirname(path), path, {
          workspacePath: root, trustedAt: new Date().toISOString()
        }));
      }
      break;
    }
    case "antigravity": {
      const path = join(home, ".gemini", "antigravity-cli", "settings.json");
      const before = readDocument(path);
      const trusted = before.trustedWorkspaces ?? [];
      if (!Array.isArray(trusted) || !trusted.every((entry) => typeof entry === "string")) {
        throw new Error(`Invalid trustedWorkspaces array in ${path}`);
      }
      const roots = isPathInside(parent, clone) ? [parent] : [parent, clone];
      writeJson(path, before, { ...before, trustedWorkspaces: [...new Set([...trusted, ...roots])] });
      break;
    }
  }
};
