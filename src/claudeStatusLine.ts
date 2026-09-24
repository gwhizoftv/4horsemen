import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { atomicWriteJson } from "./state.js";
import { assertNoSymlink } from "./paths.js";
import type { EffectOptions } from "./setupWorkspace.js";

const marker = "coord-claude-statusline-v1";
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const manifestSchema = z.object({
  marker: z.literal(marker), home: z.string(), cliEntry: z.string(), command: z.string(),
  hadLocal: z.boolean(), previous: z.unknown(), effective: z.unknown()
}).strict();
const paths = (clone: string) => ({
  local: join(clone, ".claude/settings.local.json"), project: join(clone, ".claude/settings.json"),
  manifest: join(clone, ".claude/coord-statusline.json")
});
const document = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Unsupported Claude settings.");
  return value as Record<string, unknown>;
};
const downstream = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const parsed = z.object({ type: z.literal("command"), command: z.string().min(1) }).passthrough().safeParse(value);
  if (!parsed.success) throw new Error("Unsupported Claude statusline command shape.");
  return parsed.data.command;
};
const assertPrecedence = (home: string) => {
  if ((process.env.CLAUDE_CONFIG_DIR && resolve(process.env.CLAUDE_CONFIG_DIR) !== join(home, ".claude")) ||
      ["/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json",
        join(home, ".claude/managed-settings.json")].some(existsSync)) throw new Error("Claude settings precedence is unproved; telemetry disabled.");
};
const effective = (clone: string, home: string, local: Record<string, unknown>) => {
  assertPrecedence(home);
  const value = local.statusLine ?? document(paths(clone).project).statusLine ?? document(join(home, ".claude/settings.json")).statusLine ?? null;
  downstream(value);
  return value;
};

export const claudeRetryOwner = (clone: string): "vendor" | "owner" => {
  try {
    const home = existsSync(paths(clone).manifest) ? manifestSchema.parse(document(paths(clone).manifest)).home : homedir();
    assertPrecedence(home);
    const enabled = document(paths(clone).local).autoContinueAtUsageLimit ?? document(paths(clone).project).autoContinueAtUsageLimit ??
      document(join(home, ".claude/settings.json")).autoContinueAtUsageLimit;
    return enabled === true ? "vendor" : "owner";
  } catch { return "owner"; }
};

export const inspectClaudeStatusLine = (clone: string): "installed" | "missing" | "modified" | "disabled" => {
  const p = paths(clone);
  if (!existsSync(p.manifest)) return "missing";
  try {
    assertNoSymlink(clone, p.manifest); assertNoSymlink(clone, p.local);
    const manifest = manifestSchema.parse(document(p.manifest));
    const local = document(p.local);
    if (downstream(local.statusLine) !== manifest.command) return "modified";
    const original = { ...local };
    if (manifest.hadLocal) original.statusLine = manifest.previous;
    else delete original.statusLine;
    if (JSON.stringify(effective(clone, manifest.home, original)) !== JSON.stringify(manifest.effective)) return "modified";
    return "installed";
  } catch { return "disabled"; }
};

/** Clone-local override only; never rewrites the owner's user/managed settings. */
export const syncClaudeStatusLine = (input: { clone: string; home?: string | null; cliEntry: string; options: EffectOptions }): void => {
  const { clone, options } = input;
  const home = input.home === undefined ? homedir() : input.home;
  if (home === null) return;
  const p = paths(clone);
  if (existsSync(p.manifest)) {
    const state = inspectClaudeStatusLine(clone);
    if (state !== "installed") options.log("Claude statusline modified or precedence unproved; keeping owner settings.\n");
    return;
  }
  try {
    assertNoSymlink(clone, p.local); assertNoSymlink(clone, p.manifest);
    const local = document(p.local);
    const prior = effective(clone, home, local);
    const command = `/usr/bin/env node ${quote(resolve(input.cliEntry))} claude-statusline --clone ${quote(resolve(clone))}`;
    const manifest = { marker, home, cliEntry: resolve(input.cliEntry), command,
      hadLocal: Object.hasOwn(local, "statusLine"), previous: local.statusLine ?? null, effective: prior };
    const statusLine = { ...(prior !== null && typeof prior === "object" ? prior : {}), type: "command", command };
    options.changes.push(p.local, p.manifest);
    options.log(`${options.dryRun ? "would install" : "installed"} Claude statusline tee in ${clone}\n`);
    if (!options.dryRun) {
      atomicWriteJson(clone, p.manifest, manifest);
      atomicWriteJson(clone, p.local, { ...local, statusLine });
    }
  } catch { options.log("Claude statusline precedence or ownership unproved; telemetry disabled.\n"); }
};

export const removeClaudeStatusLine = (clone: string, options: EffectOptions): void => {
  const p = paths(clone);
  if (!existsSync(p.manifest)) return;
  // Inherited-command drift is not ownership of the override: retain edits rather than guessing.
  if (inspectClaudeStatusLine(clone) !== "installed") { options.log("Kept modified Claude statusline.\n"); return; }
  const manifest = manifestSchema.parse(document(p.manifest));
  const local = document(p.local);
  if (manifest.hadLocal) local.statusLine = manifest.previous;
  else delete local.statusLine;
  options.changes.push(p.local, p.manifest);
  if (!options.dryRun) { atomicWriteJson(clone, p.local, local); unlinkSync(p.manifest); }
};

/** Stream the owner input unchanged; retain only a bounded telemetry copy. */
export const runClaudeStatusLine = async (clone: string, streams: {
  input: Readable; output: Writable; error: Writable
} = { input: process.stdin, output: process.stdout, error: process.stderr }): Promise<number> => {
  const p = paths(clone);
  assertNoSymlink(clone, p.manifest);
  const manifest = manifestSchema.parse(document(p.manifest));
  const command = downstream(manifest.effective);
  const owner = command === null ? null : spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
  owner?.stdout.pipe(streams.output, { end: false });
  owner?.stderr.pipe(streams.error, { end: false });
  const completed = owner === null ? Promise.resolve(0) : new Promise<number>((done) => {
    owner.once("error", () => done(1)); owner.once("close", (code) => done(code ?? 1));
    owner.stdin.on("error", () => { /* Owner may intentionally close stdin early. */ });
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const inputDone = new Promise<void>((done) => {
    streams.input.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 8192) chunks.push(chunk); else chunks.length = 0;
    });
    streams.input.once("end", done);
    streams.input.once("error", done);
  });
  if (owner !== null) streams.input.pipe(owner.stdin); else streams.input.resume();
  await inputDone;
  if (bytes <= 8192 && inspectClaudeStatusLine(clone) === "installed") {
    await new Promise<void>((done) => {
      const receiver = spawn(process.execPath, [manifest.cliEntry, "agent-event", "--vendor", "claude", "--event", "status-line", "--clone", clone],
        { stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => { receiver.kill("SIGKILL"); }, 2000);
      receiver.once("error", () => { clearTimeout(timer); done(); });
      receiver.once("close", () => { clearTimeout(timer); done(); });
      receiver.stdin.on("error", () => { /* Telemetry must not alter owner status. */ });
      receiver.stdin.end(Buffer.concat(chunks));
    });
  }
  return completed;
};
