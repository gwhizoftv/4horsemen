import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_LIFECYCLE_HOOK_MARKER,
  agentLifecycleHookPath,
  inspectAgentLifecycleHooks,
  removeAgentLifecycleHooks,
  removeAntigravityStatusLine,
  syncAgentLifecycleHooks,
  syncAntigravityStatusLine
} from "../src/agentHookSync.js";
import { effectOptions } from "../src/setupWorkspace.js";
import { inspectClaudeStatusLine, removeClaudeStatusLine, runClaudeStatusLine, syncClaudeStatusLine } from "../src/claudeStatusLine.js";
import { PassThrough } from "node:stream";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-agent-hooks-"));
  roots.push(root);
  const clone = join(root, "clone");
  mkdirSync(clone);
  return { root, clone, cliEntry: join(root, "coord", "dist", "main.js") };
};

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("agent lifecycle hook synchronization", () => {
  it("forwards byte-exact Claude input and owner exit status even when telemetry fails", async () => {
    const { root, clone, cliEntry } = fixture();
    mkdirSync(join(clone, ".claude"));
    const local = join(clone, ".claude/settings.local.json");
    const prior = { type: "command", command: "cat; printf owner-error >&2; exit 7", padding: 3 };
    writeFileSync(local, JSON.stringify({ statusLine: prior }));
    syncClaudeStatusLine({ clone, cliEntry, home: root, options: effectOptions(() => undefined, false) });
    for (const payload of ["{\"session_id\":\"session\"}\n\n", "x".repeat(9000) + "\n"]) {
      const input = new PassThrough(); const output = new PassThrough(); const error = new PassThrough();
      let stdout = ""; let stderr = "";
      output.on("data", (data: Buffer) => { stdout += data.toString(); });
      error.on("data", (data: Buffer) => { stderr += data.toString(); });
      const result = runClaudeStatusLine(clone, { input, output, error });
      input.end(payload);
      expect(await result).toBe(7);
      expect(stdout).toBe(payload); expect(stderr).toBe("owner-error");
    }
    removeClaudeStatusLine(clone, effectOptions(() => undefined, false));
    expect(json(local).statusLine).toEqual(prior);
  });
  it("owns only the Claude local override, detects inherited drift, and restores exact prior absence", () => {
    const { root, clone, cliEntry } = fixture();
    const home = join(root, "home"); mkdirSync(join(home, ".claude"), { recursive: true });
    const userPath = join(home, ".claude/settings.json");
    writeFileSync(userPath, JSON.stringify({ statusLine: { type: "command", command: "cat", padding: 2 } }));
    const local = join(clone, ".claude/settings.local.json");
    syncClaudeStatusLine({ clone, cliEntry, home, options: effectOptions(() => undefined, true) });
    expect(existsSync(local)).toBe(false);
    syncClaudeStatusLine({ clone, cliEntry, home, options: effectOptions(() => undefined, false) });
    expect(inspectClaudeStatusLine(clone)).toBe("installed");
    expect(json(local).statusLine).toMatchObject({ padding: 2 });
    const second = effectOptions(() => undefined, false);
    syncClaudeStatusLine({ clone, cliEntry, home, options: second });
    expect(second.changes).toEqual([]);
    writeFileSync(userPath, JSON.stringify({ statusLine: { type: "command", command: "new-command" } }));
    expect(inspectClaudeStatusLine(clone)).toBe("modified");
    removeClaudeStatusLine(clone, effectOptions(() => undefined, false));
    expect(json(local).statusLine).toBeDefined();
    writeFileSync(userPath, JSON.stringify({ statusLine: { type: "command", command: "cat", padding: 2 } }));
    removeClaudeStatusLine(clone, effectOptions(() => undefined, false));
    expect(json(local).statusLine).toBeUndefined();
    expect(json(userPath).statusLine).toMatchObject({ command: "cat" });
  });

  it("does not install Claude telemetry over ambiguous managed settings", () => {
    const { root, clone, cliEntry } = fixture();
    mkdirSync(join(root, ".claude")); writeFileSync(join(root, ".claude/managed-settings.json"), "{}");
    syncClaudeStatusLine({ clone, cliEntry, home: root, options: effectOptions(() => undefined, false) });
    expect(inspectClaudeStatusLine(clone)).toBe("missing");
  });
  for (const agent of ["codex", "claude", "cursor", "antigravity"] as const) {
    it(`installs and removes only the managed ${agent} definitions`, () => {
      const { clone, cliEntry } = fixture();
      const path = agentLifecycleHookPath(clone, agent)!;
      mkdirSync(dirname(path), { recursive: true });
      const existing =
        agent === "antigravity"
          ? { "third-party": { Stop: [{ command: "echo keep" }] } }
          : { hooks: { ThirdParty: [{ command: "echo keep" }] }, custom: true };
      writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
      const effects = effectOptions(() => undefined, false);
      expect(syncAgentLifecycleHooks({ clone, agent, cliEntry, options: effects }).changed).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(AGENT_LIFECYCLE_HOOK_MARKER);
      expect(inspectAgentLifecycleHooks({ clone, agent, cliEntry }).kind).toBe("current");

      const second = effectOptions(() => undefined, false);
      expect(syncAgentLifecycleHooks({ clone, agent, cliEntry, options: second }).changed).toBe(false);
      expect(second.changes).toEqual([]);

      const removal = effectOptions(() => undefined, false);
      expect(removeAgentLifecycleHooks({ clone, agent, options: removal }).changed).toBe(true);
      expect(readFileSync(path, "utf8")).not.toContain(AGENT_LIFECYCLE_HOOK_MARKER);
      expect(JSON.stringify(json(path))).toContain("echo keep");
    });
  }

  it("installs all managed Cursor lifecycle and analytics hooks", () => {
    const { clone, cliEntry } = fixture();
    const effects = effectOptions(() => undefined, false);
    syncAgentLifecycleHooks({ clone, agent: "cursor", cliEntry, options: effects });
    const document = json(agentLifecycleHookPath(clone, "cursor")!);
    const hooks = document.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual(
      [
        "afterAgentResponse",
        "beforeSubmitPrompt",
        "postToolUse",
        "postToolUseFailure",
        "sessionEnd",
        "sessionStart",
        "stop"
      ].sort()
    );
  });

  it("reports dry-run work without creating vendor files", () => {
    const { clone, cliEntry } = fixture();
    const effects = effectOptions(() => undefined, true);
    const outcome = syncAgentLifecycleHooks({ clone, agent: "codex", cliEntry, options: effects });
    expect(outcome.changed).toBe(true);
    expect(existsSync(outcome.path!)).toBe(false);
    expect(effects.changes).toHaveLength(1);
  });

  it("keeps an owner handler added beside a managed nested handler", () => {
    const { clone, cliEntry } = fixture();
    const path = agentLifecycleHookPath(clone, "codex")!;
    syncAgentLifecycleHooks({
      clone,
      agent: "codex",
      cliEntry,
      options: effectOptions(() => undefined, false)
    });
    const document = json(path);
    const hooks = document.hooks as Record<string, unknown[]>;
    const managedGroup = hooks.Stop?.at(-1) as Record<string, unknown>;
    managedGroup.hooks = [
      ...((managedGroup.hooks as unknown[]) ?? []),
      { type: "command", command: "owner-stop-handler" }
    ];
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);

    removeAgentLifecycleHooks({
      clone,
      agent: "codex",
      options: effectOptions(() => undefined, false)
    });
    expect(readFileSync(path, "utf8")).toContain("owner-stop-handler");
    expect(readFileSync(path, "utf8")).not.toContain(AGENT_LIFECYCLE_HOOK_MARKER);
  });

  it("refuses to overwrite an unrelated Antigravity hook with the managed name", () => {
    const { clone, cliEntry } = fixture();
    const path = agentLifecycleHookPath(clone, "antigravity")!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ "coord-agent-lifecycle": { Stop: [{ command: "owner-hook" }] } })}\n`);
    expect(() =>
      syncAgentLifecycleHooks({
        clone,
        agent: "antigravity",
        cliEntry,
        options: effectOptions(() => undefined, false)
      })
    ).toThrow("already defines");
    expect(readFileSync(path, "utf8")).toContain("owner-hook");
  });

  it("multiplexes and restores an existing Antigravity status line", () => {
    const { root, cliEntry } = fixture();
    const home = join(root, "home");
    const settings = join(home, ".gemini", "antigravity-cli", "settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    const original = { type: "command", command: "/opt/owner-status", padding: 2 };
    writeFileSync(settings, `${JSON.stringify({ theme: "dark", statusLine: original }, null, 2)}\n`);
    const effects = effectOptions(() => undefined, false);
    expect(syncAntigravityStatusLine({ home, cliEntry, options: effects }).changed).toBe(true);
    const installed = json(settings);
    const command = (installed.statusLine as Record<string, unknown>).command as string;
    expect(command).toContain("coord-agent-lifecycle-statusline.sh");
    const wrapper = readFileSync(command, "utf8");
    expect(wrapper).toContain("/opt/owner-status");
    expect(wrapper).toContain("agent-event --vendor antigravity --event status-line");
    expect(wrapper).toContain(") &");
    expect(JSON.stringify(installed)).not.toContain("stack_with_default");

    expect(removeAntigravityStatusLine({ home, options: effectOptions(() => undefined, false) })).toEqual({
      changed: true,
      kept: false
    });
    expect(json(settings)).toEqual({ theme: "dark", statusLine: original });
    expect(existsSync(command)).toBe(false);
  });

  it("leaves a user-edited Antigravity status line in place during uninstall", () => {
    const { root, cliEntry } = fixture();
    const home = join(root, "home");
    const effects = effectOptions(() => undefined, false);
    syncAntigravityStatusLine({ home, cliEntry, options: effects });
    const settings = join(home, ".gemini", "antigravity-cli", "settings.json");
    writeFileSync(settings, `${JSON.stringify({ statusLine: { type: "command", command: "owner-new" } }, null, 2)}\n`);
    expect(removeAntigravityStatusLine({ home, options: effectOptions(() => undefined, false) })).toEqual({
      changed: false,
      kept: true
    });
    expect(readFileSync(settings, "utf8")).toContain("owner-new");
  });
});
