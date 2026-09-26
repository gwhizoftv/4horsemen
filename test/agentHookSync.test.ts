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
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import {
  claudeStatusLinePaths,
  inspectClaudeStatusLine,
  removeClaudeStatusLine,
  syncClaudeStatusLine
} from "../src/claudeStatusLine.js";

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

describe("Claude status-line tee", () => {
  const teeFixture = () => {
    const base = fixture();
    const home = join(base.root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    // Stand-in coord CLI: records the telemetry copy it receives.
    const received = join(base.root, "received.json");
    mkdirSync(dirname(base.cliEntry), { recursive: true });
    writeFileSync(base.cliEntry, `require("fs").writeFileSync(${JSON.stringify(received)}, require("fs").readFileSync(0));\n`);
    const owner = join(base.root, "owner-statusline.sh");
    // Newline-sensitive owner command: \`read\` fails without the terminating newline.
    writeFileSync(owner, "#!/bin/sh\nread -r first || exit 9\nprintf 'owner:%s|' \"$first\"\ncat\necho owner-stderr >&2\nexit 7\n");
    chmodSync(owner, 0o700);
    const context = { clone: base.clone, home, cliEntry: base.cliEntry, managedSettings: [] as string[] };
    const run = (input: string) => spawnSync(claudeStatusLinePaths(base.clone).wrapper, { input, encoding: "utf8" });
    // The receiver runs in the background; let it release its exclusion before the tree is removed.
    const settled = async (): Promise<void> => {
      for (let attempt = 0; attempt < 200 && existsSync(claudeStatusLinePaths(base.clone).lock); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    return { ...base, home, received, owner, context, run, settled };
  };

  it("runs the owner's effective command on the original bytes and restores the clone layer exactly", async () => {
    const f = teeFixture();
    writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: f.owner, padding: 2 } }));
    const local = claudeStatusLinePaths(f.clone).local;
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, JSON.stringify({ hooks: { Stop: [] } }));
    const options = effectOptions(() => undefined, false);
    expect(syncClaudeStatusLine({ ...f.context, options })).toEqual({ changed: true, disabled: null });
    expect(json(local).statusLine).toEqual({ type: "command", command: claudeStatusLinePaths(f.clone).wrapper, padding: 2 });
    const payload = `{"session_id":"s1","rate_limits":{}}\nsecond line\n`;
    const result = f.run(payload);
    expect(result.stdout).toBe(`owner:{"session_id":"s1","rate_limits":{}}|second line\n`);
    expect(result.stderr).toContain("owner-stderr");
    expect(result.status).toBe(7);
    for (let attempt = 0; attempt < 100 && !existsSync(f.received); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readFileSync(f.received, "utf8")).toBe(payload);
    await f.settled();
    const repeat = effectOptions(() => undefined, false);
    syncClaudeStatusLine({ ...f.context, options: repeat });
    expect(repeat.changes).toEqual([]);
    expect(inspectClaudeStatusLine(f.context).kind).toBe("current");
    // The owner's effective command moved: report drift, never keep running the old one silently.
    writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo new" } }));
    expect(inspectClaudeStatusLine(f.context).kind).toBe("modified");
    expect(removeClaudeStatusLine({ clone: f.clone, options: effectOptions(() => undefined, false) })).toEqual({ changed: true, kept: false });
    expect(json(local)).toEqual({ hooks: { Stop: [] } });
    expect(existsSync(claudeStatusLinePaths(f.clone).wrapper)).toBe(false);
  });

  it("kills and reaps a receiver that never finishes, one at a time, without touching owner output", async () => {
    const f = teeFixture();
    writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo shown" } }));
    const pids = join(f.root, "receiver-pids");
    writeFileSync(f.cliEntry, `require("fs").appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n"); setInterval(() => {}, 1000);\n`);
    syncClaudeStatusLine({ ...f.context, options: effectOptions(() => undefined, false) });
    const lock = join(f.clone, ".claude", "coord-statusline.lock");
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const wait = async (condition: () => boolean, ms: number): Promise<void> => {
      for (const until = Date.now() + ms; !condition() && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    expect(f.run("{}\n")).toMatchObject({ stdout: "shown\n", status: 0 });
    await wait(() => existsSync(pids), 3_000);
    expect(f.run("{}\n")).toMatchObject({ stdout: "shown\n", status: 0 }); // no second receiver while one holds the lock
    const pid = Number(readFileSync(pids, "utf8").trim());
    expect(readFileSync(pids, "utf8").trim().split("\n")).toHaveLength(1);
    await wait(() => !alive(pid) && !existsSync(lock), 8_000);
    expect(alive(pid)).toBe(false);
    expect(existsSync(lock)).toBe(false);
  }, 15_000);

  it("prints nothing without an owner command and disables itself when precedence is not provable", async () => {
    const f = teeFixture();
    const dry = effectOptions(() => undefined, true);
    syncClaudeStatusLine({ ...f.context, options: dry });
    expect(dry.changes).toHaveLength(1);
    expect(existsSync(claudeStatusLinePaths(f.clone).local)).toBe(false);
    syncClaudeStatusLine({ ...f.context, options: effectOptions(() => undefined, false) });
    const quiet = f.run("{}\n");
    await f.settled();
    expect(quiet.stdout).toBe("");
    expect(quiet.status).toBe(0);

    const managed = join(f.root, "managed-settings.json");
    writeFileSync(managed, JSON.stringify({ statusLine: { type: "command", command: "managed" } }));
    const other = fixture();
    const shadowed = syncClaudeStatusLine({ ...f.context, clone: other.clone, managedSettings: [managed], options: effectOptions(() => undefined, false) });
    expect(shadowed.disabled).toMatch(/managed settings/);
    expect(existsSync(claudeStatusLinePaths(other.clone).local)).toBe(false);
    const launcher = join(other.clone, "start-claude.sh");
    writeFileSync(launcher, "exec claude --settings /elsewhere.json\n");
    expect(syncClaudeStatusLine({ ...f.context, clone: other.clone, launcher, options: effectOptions(() => undefined, false) }).disabled)
      .toMatch(/--settings/);

    // An owner edit after installation wins, and uninstall leaves it alone.
    const local = claudeStatusLinePaths(f.clone).local;
    writeFileSync(local, JSON.stringify({ statusLine: { type: "command", command: "mine" } }));
    expect(syncClaudeStatusLine({ ...f.context, options: effectOptions(() => undefined, false) }).disabled).toMatch(/owner replaced/);
    expect(removeClaudeStatusLine({ clone: f.clone, options: effectOptions(() => undefined, false) })).toEqual({ changed: false, kept: true });
    expect(json(local).statusLine).toEqual({ type: "command", command: "mine" });
  });
});
