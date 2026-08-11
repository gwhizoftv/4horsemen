import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../src/hash.js";
import { createMirror, type Mirror } from "../src/mirror.js";
import { coordPaths } from "../src/paths.js";
import type { CheckOutcome, LoopDeps } from "../src/runLoop.js";
import {
  ensureRuntimeLayout,
  initialCursors,
  loadRuntimeState,
  writeJsonAtomic,
  writeStartRecord,
  type RuntimeState,
  type StartRecord
} from "../src/state.js";
import { RUNTIME_FORMAT_VERSION, type GateId, type Profile } from "../src/steps.js";
import type { TmuxController } from "../src/tmux.js";
import { createBareOrigin, createGitFixture, type GitFixture } from "./gitFixture.js";

/**
 * A full runtime: real bare origin, real per-agent clones, real mirror, and a
 * control root outside all of them. Only tmux is faked — the run loop is
 * otherwise exercised against the same boundaries it uses in production.
 */

export type FakeTmux = TmuxController & { readonly inserts: { target: string; text: string }[] };

export const fakeTmux = (available = false): FakeTmux => {
  const inserts: { target: string; text: string }[] = [];

  return {
    available,
    inserts,
    paneTarget: (issue, agent) => `consensus-${issue}:${agent}.0`,
    ensureSession: () => ({ ok: true }),
    launchAgent: () => ({ ok: true }),
    paneExists: () => true,
    foregroundCommand: () => "claude",
    paneInMode: () => false,
    harnessDisappeared: () => false,
    insert: (target, text) => {
      inserts.push({ target, text });

      return { ok: true };
    },
    killSession: () => undefined
  };
};

export type Workspace = {
  readonly root: string;
  readonly originPath: string;
  readonly baselineSha: string;
  readonly state: RuntimeState;
  readonly mirror: Mirror;
  readonly clones: Readonly<Record<string, GitFixture>>;
  /** Commit files on an agent's branch, push, and return the commit SHA. */
  publish: (agent: string, message: string, files: Record<string, string>) => string;
  /** Write an agent's completion file, exactly as an agent would. */
  submit: (agent: string, sha: string) => void;
  reload: () => RuntimeState;
  cleanup: () => void;
};

export type WorkspaceOptions = {
  readonly roster?: readonly string[];
  readonly profile?: Profile;
  readonly firstGate?: GateId;
  readonly maxRevisionRounds?: number;
  readonly finalChecks?: StartRecord["finalChecks"];
  readonly prPolicy?: StartRecord["prPolicy"];
};

export const createWorkspace = (options: WorkspaceOptions = {}): Workspace => {
  const roster = options.roster ?? ["antigravity", "claude", "codex", "cursor"];
  const origin = createBareOrigin();
  const seed = createGitFixture("coord-seed-");

  seed.git("remote", "add", "origin", origin.path);

  const baselineSha = seed.commit("baseline", { "README.md": "# base\n" });

  seed.git("push", "--quiet", "origin", "main");

  const clones: Record<string, GitFixture> = {};

  for (const agent of roster) {
    const clone = createGitFixture(`coord-clone-${agent}-`);

    clone.git("remote", "add", "origin", origin.path);
    clone.git("fetch", "--quiet", "origin", "main");
    clone.git("checkout", "--quiet", "-B", `issue-1/${agent}`, "FETCH_HEAD");
    clone.git("push", "--quiet", "origin", `issue-1/${agent}`);
    clones[agent] = clone;
  }

  const root = mkdtempSync(join(tmpdir(), "coord-ctl-"));
  const paths = coordPaths(root, 1);
  const now = "2026-08-11T01:00:00Z";
  const start: StartRecord = {
    runtimeFormatVersion: RUNTIME_FORMAT_VERSION,
    issue: 1,
    issueSessionId: `issue-1:${baselineSha}`,
    baselineSha,
    profile: options.profile ?? "consensus",
    originalRoster: [...roster],
    agentRoots: Object.fromEntries(roster.map((agent) => [agent, (clones[agent] as GitFixture).root])),
    harnesses: Object.fromEntries(roster.map((agent) => [agent, agent])),
    nudgeAllowed: Object.fromEntries(roster.map((agent) => [agent, agent === "claude"])),
    baseBranch: "main",
    branchTemplate: "issue-{issue}/{agent}",
    maxRevisionRounds: options.maxRevisionRounds ?? 3,
    prPolicy: options.prPolicy ?? "owner-only",
    automationDigest: sha256(`v3:${baselineSha}:${[...roster].sort().join(",")}`),
    automationDigestScheme: "v3",
    trustedSourceCommit: baselineSha,
    finalChecks: options.finalChecks ?? [],
    createdAt: now
  };

  ensureRuntimeLayout(paths, roster);
  writeStartRecord(paths, start);
  writeJsonAtomic(paths.cursorsJson, initialCursors(start, options.firstGate ?? "gate-1-join", now), paths.root);

  const mirror = createMirror(paths.mirror);

  mirror.ensure(origin.path);

  const loaded = loadRuntimeState(root, 1);

  if (!loaded.ok) {
    throw new Error(`workspace state failed to load: ${loaded.errors.join("; ")}`);
  }

  return {
    root,
    originPath: origin.path,
    baselineSha,
    mirror,
    clones,
    state: loaded.value,
    publish: (agent, message, files) => {
      const clone = clones[agent];

      if (clone === undefined) {
        throw new Error(`unknown agent ${agent}`);
      }

      const sha = clone.commit(message, files);

      clone.git("push", "--quiet", "origin", `issue-1/${agent}`);

      return sha;
    },
    submit: (agent, sha) => {
      writeFileSync(paths.completeFile(agent), `${sha}\n`);
    },
    reload: () => {
      const reloaded = loadRuntimeState(root, 1);

      if (!reloaded.ok) {
        throw new Error(`state failed to reload: ${reloaded.errors.join("; ")}`);
      }

      return reloaded.value;
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      origin.cleanup();
      seed.cleanup();

      for (const clone of Object.values(clones)) {
        clone.cleanup();
      }
    }
  };
};

export const loopDeps = (
  workspace: Workspace,
  overrides: Partial<LoopDeps> = {}
): LoopDeps & { readonly checks: CheckOutcome[]; readonly notices: string[] } => {
  const checks: CheckOutcome[] = [];
  const notices: string[] = [];

  return {
    checks,
    notices,
    mirror: workspace.mirror,
    tmux: fakeTmux(),
    now: () => "2026-08-11T02:00:00Z",
    sleep: async () => undefined,
    runCheck: (argv) => {
      const outcome: CheckOutcome = { argv, exitCode: 0, detail: "" };

      checks.push(outcome);

      return outcome;
    },
    notify: (message) => notices.push(message),
    ...overrides
  };
};

/** A join signal that satisfies the join predicate for this workspace. */
export const joinSignal = (workspace: Workspace, agent: string): string =>
  JSON.stringify({
    issue: 1,
    issueSessionId: workspace.state.start.issueSessionId,
    agent,
    createdAt: "2026-08-11T01:30:00Z",
    baselineSha: workspace.baselineSha,
    automationDigest: workspace.state.start.automationDigest,
    automationDigestScheme: workspace.state.start.automationDigestScheme
  });

export const validPlan = [
  "# Plan",
  "",
  "## Exact file map",
  "",
  "- src/a.ts",
  "",
  "## Tests",
  "",
  "unit tests",
  "",
  "## Risks and mitigations",
  "",
  "none known",
  "",
  "## Conclusion",
  "",
  "ship it",
  ""
].join("\n");
