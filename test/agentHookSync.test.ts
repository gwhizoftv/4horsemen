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
