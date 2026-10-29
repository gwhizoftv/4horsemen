import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findAgentLanguageViolations } from "../src/agentLanguage.js";
import { syncAgentTrust } from "../src/agentTrust.js";
import { assertInstallDeletionAllowed, install, uninstall } from "../src/install.js";
import { readConfig } from "../src/state.js";
import { cloneGitHubWiringProblem } from "../src/setupWorkspace.js";
import { nestedConfigPath } from "../src/workspace.js";
import { DEFAULT_CLONE_IGNORES } from "../src/productIgnore.js";
import {
  declaredChecks,
  ensureBuilt,
  git,
  makeProduct,
  passingVerify,
  repoRoot,
  silence,
  tryGit,
  writeDeclaration,
  type ProductFixture
} from "./support/workspaceFixture.js";

const fixtures: ProductFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

const product = (kind: "go" | "plain" = "go"): ProductFixture => {
  ensureBuilt();
  const fixture = makeProduct(kind);
  fixtures.push(fixture);
  return fixture;
};

const installOnce = (
  fixture: ProductFixture,
  overrides: Partial<Parameters<typeof install>[0]> = {}
): ReturnType<typeof install> => {
  const io = silence();
  return install({
    installRoot: repoRoot,
    productRoot: fixture.productRoot,
    coordRoot: fixture.coordRoot,
    agents: ["claude"],
    profile: "solo",
    writeProduct: false,
    vendor: false,
    bootstrap: false,
    dryRun: false,
    log: io.log,
    declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }),
    // Never the owner's real home: an Antigravity install writes user-global settings there.
    home: join(fixture.workspaceRoot, "home"),
    ...overrides
  });
};

describe("coord install — two-mode footprint", () => {
  it("uses the selected pnpm in setup helpers without enabling Corepack, and keeps dry-run inert", () => {
    const fixture = product("plain");
    const bin = join(fixture.workspaceRoot, "native-pnpm");
    const pnpmLog = join(fixture.workspaceRoot, "pnpm.log");
    const corepackLog = join(fixture.workspaceRoot, "corepack.log");
    mkdirSync(bin);
    writeFileSync(join(fixture.productRoot, "package.json"), JSON.stringify({ name: "native-pnpm-fixture" }));
    writeFileSync(join(fixture.productRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$*" >"$SETUP_PNPM_LOG"\n', { mode: 0o700 });
    writeFileSync(join(bin, "corepack"), '#!/bin/sh\necho invoked >"$SETUP_COREPACK_LOG"\nexit 42\n', { mode: 0o700 });
    const setup = (dryRun: boolean) => spawnSync("bash", ["-c",
      '. "$1"; CLONE_DIR="$2"; DRY_RUN="$3"; common_detect_project',
      "_", join(repoRoot, "scripts/setup_common.sh"), fixture.productRoot, String(dryRun)], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, SETUP_PNPM_LOG: pnpmLog, SETUP_COREPACK_LOG: corepackLog }
    });

    const dryRun = setup(true);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain("DRY-RUN:");
    expect(existsSync(pnpmLog)).toBe(false);
    expect(existsSync(corepackLog)).toBe(false);

    const installed = setup(false);
    expect(installed.status, installed.stderr).toBe(0);
    expect(existsSync(corepackLog)).toBe(false);
    expect(readFileSync(pnpmLog, "utf8")).toBe(`${fixture.productRoot}\ninstall --frozen-lockfile\n`);
  });

  it("isolates its bootstrap Node PATH from the product environment", () => {
    const fixture = product();
    const oldBin = join(fixture.workspaceRoot, "old-node");
    mkdirSync(oldBin);
    writeFileSync(join(oldBin, "node"), "#!/bin/sh\necho v16.18.0\n", { mode: 0o700 });
    const productPath = `${oldBin}${delimiter}${process.env.PATH ?? ""}`;
    vi.stubEnv("PATH", productPath);
    const original = childProcess.spawnSync;
    const paths: (string | undefined)[] = [];
    const commands: unknown[] = [];
    const spy = vi.spyOn(childProcess, "spawnSync").mockImplementation((command, args, options) => {
      if (command !== "pnpm") return original(command, args, options);
      commands.push(args);
      paths.push(options?.env?.PATH);
      return { pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0, signal: null };
    });
    syncBuiltinESMExports();
    try {
      installOnce(fixture, { bootstrap: true });
      expect(commands).toEqual([["install", "--frozen-lockfile"], ["build"]]);
      expect(paths).toEqual(Array(2).fill(`${dirname(process.execPath)}${delimiter}${productPath}`));
      expect(process.env.PATH).toBe(productPath);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
    }
  });

  it("persists parent trust for all vendors while preserving existing settings and repeat-install bytes", () => {
    const fixture = product();
    // Outside the product parent: a home inside it is never trusted as one.
    const home = join(product().workspaceRoot, "home");
    const parent = realpathSync(fixture.workspaceRoot);
    const codexConfig = join(home, ".codex/config.toml");
    const claudeConfig = join(home, ".claude.json");
    const agyConfig = join(home, ".gemini/antigravity-cli/settings.json");
    mkdirSync(dirname(codexConfig), { recursive: true });
    mkdirSync(dirname(agyConfig), { recursive: true });
    writeFileSync(codexConfig, `model = "owner-model"\n[projects.'${parent}'] # keep this table\ntrust_level = "untrusted"\nowner_setting = true\n`);
    writeFileSync(claudeConfig, JSON.stringify({ theme: "dark", projects: { [parent]: { allowedTools: ["Read"] } } }));
    writeFileSync(agyConfig, JSON.stringify({ model: "owner-model", allowNonWorkspaceAccess: false, trustedWorkspaces: ["/owner/notes"] }));
    const agents = ["claude", "codex", "cursor", "antigravity"];
    installOnce(fixture, { agents, home });
    const codex = readFileSync(codexConfig, "utf8");
    expect(codex).toContain('model = "owner-model"');
    expect(codex).toContain(`projects.'${parent}'] # keep this table\ntrust_level = "trusted"\nowner_setting = true`);
    expect(codex).toContain(`[projects.${JSON.stringify(join(parent, "myserver-codex"))}]\ntrust_level = "trusted"`);
    expect(JSON.parse(readFileSync(claudeConfig, "utf8"))).toMatchObject({ theme: "dark", projects: {
      [parent]: { hasTrustDialogAccepted: true, allowedTools: ["Read"] },
      [join(parent, "myserver-claude")]: { hasTrustDialogAccepted: true }
    } });
    expect(JSON.parse(readFileSync(agyConfig, "utf8"))).toMatchObject({
      model: "owner-model", allowNonWorkspaceAccess: false, trustedWorkspaces: ["/owner/notes", parent]
    });
    const projects = join(home, ".cursor/projects");
    const markers = readdirSync(projects).map((key) => join(projects, key, ".workspace-trusted"));
    const roots = markers.map((path) => JSON.parse(readFileSync(path, "utf8")).workspacePath);
    expect(roots).toContain(parent);
    // This fixture's runtime is outside the product parent. Trust its stable
    // root once, so future issue directories are covered too.
    expect(roots).toContain(realpathSync(fixture.coordRoot));
    expect(roots.some((root: string) => /issue-\d/.test(root))).toBe(false);
    const paths = [codexConfig, claudeConfig, agyConfig, ...markers];
    const bytes = paths.map((path) => readFileSync(path, "utf8"));
    const repeated = installOnce(fixture, { agents, home });
    expect(repeated.changes.filter((entry) => entry.includes("folder trust"))).toEqual([]);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(bytes);
  });

  it("shares trust with setup scripts, respects vendor homes, and makes dry-run write nothing", () => {
    const fixture = product();
    const parent = realpathSync(fixture.workspaceRoot);
    const home = join(parent, "isolated-home");
    const options = { dryRun: true, log: () => undefined, changes: [] as string[] };
    for (const agent of ["claude", "codex", "cursor", "antigravity"]) {
      syncAgentTrust({ agent, productRoot: realpathSync(fixture.productRoot), clone: join(parent, `myserver-${agent}`), home, options });
      expect(readFileSync(join(repoRoot, `scripts/setup_${agent}.sh`), "utf8")).toContain("common_configure_trust\n");
    }
    // This artificial home is inside the parent, so trust only each clone.
    expect(options.changes).toHaveLength(4);
    expect(existsSync(home)).toBe(false);
    options.dryRun = false;
    syncAgentTrust({ agent: "cursor", productRoot: fixture.productRoot, clone: join(parent, "myserver-cursor"), home,
      env: { CURSOR_DATA_DIR: join(parent, "cursor-data"), CURSOR_CONFIG_DIR: join(parent, "wrong-config") }, options });
    const cursorProjects = join(parent, "cursor-data/projects");
    expect(readdirSync(cursorProjects)).toEqual([join(parent, "myserver-cursor")]
      .map((root) => root.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")));
    expect(existsSync(join(parent, "wrong-config"))).toBe(false);
    syncAgentTrust({ agent: "claude", productRoot: fixture.productRoot, clone: join(parent, "myserver-claude"), home,
      env: { CLAUDE_CONFIG_DIR: join(parent, "claude-config") }, options });
    expect(existsSync(join(parent, "claude-config/.claude.json"))).toBe(true);
    // Execute the shared setup helper against an installed clone without
    // running the rest of the legacy identity/MCP/permission setup.
    const installed = installOnce(fixture, { agents: ["codex"], home: null });
    const codexHome = join(parent, "codex-config");
    const productBin = join(parent, "product-node");
    mkdirSync(productBin);
    writeFileSync(join(productBin, "node"), "#!/bin/sh\n[ \"$1\" = --version ] || exit 99\necho v16.18.0\n", { mode: 0o700 });
    const setupTrust = (dryRun: boolean) => execFileSync("bash", ["-c",
      '. "$1"; AGENT_NAME=codex; MASTER_ROOT="$2"; CLONE_DIR="$3"; DRY_RUN="$4"; common_configure_trust',
      "_", join(repoRoot, "scripts/setup_common.sh"), fixture.productRoot, installed.clones[0]!, String(dryRun)], {
        env: { ...process.env, CODEX_HOME: codexHome, PATH: `${productBin}:/usr/bin:/bin`, COORD_NODE: process.execPath }, stdio: "pipe"
      });
    setupTrust(true);
    expect(existsSync(codexHome)).toBe(false);
    setupTrust(false);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain(`[projects.${JSON.stringify(parent)}]`);
    expect(existsSync(home)).toBe(false);
  });

  it.each(["home", "ancestor", "filesystem root", "shallow folder"])("does not use %s as the shared trusted parent", (layout) => {
    const fixture = product();
    const home = realpathSync(fixture.workspaceRoot);
    const parent = layout === "home" ? home : layout === "ancestor" ? dirname(home) : layout === "filesystem root" ? "/" : "/repos";
    const productRoot = join(parent, "myserver");
    const options = { dryRun: false, log: () => undefined, changes: [] as string[] };
    for (const agent of ["claude", "codex", "cursor", "antigravity"]) {
      syncAgentTrust({ agent, productRoot, clone: join(parent, `myserver-${agent}`), home, options });
    }
    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { projects: Record<string, unknown> };
    expect(Object.keys(claude.projects)).toEqual([join(parent, "myserver-claude")]);
    const codex = readFileSync(join(home, ".codex/config.toml"), "utf8");
    expect(codex).not.toContain(`[projects.${JSON.stringify(parent)}]`);
    expect(codex).toContain(`[projects.${JSON.stringify(join(parent, "myserver-codex"))}]`);
    const agy = JSON.parse(readFileSync(join(home, ".gemini/antigravity-cli/settings.json"), "utf8")) as { trustedWorkspaces: string[] };
    expect(agy.trustedWorkspaces).toEqual([join(parent, "myserver-antigravity")]);
    const cursorProjects = join(home, ".cursor/projects");
    expect(readdirSync(cursorProjects).map((key) => JSON.parse(readFileSync(join(cursorProjects, key, ".workspace-trusted"), "utf8")).workspacePath))
      .toEqual([join(parent, "myserver-cursor")]);
  });

  it.each(["missing install root", "missing trust module"])("explains setup trust failure for a %s", (scenario) => {
    const fixture = product();
    if (scenario === "missing trust module") git(fixture.productRoot, "config", "coord.installRoot", fixture.workspaceRoot);
    const result = spawnSync("bash", ["-c",
      '. "$1"; AGENT_NAME=codex; MASTER_ROOT="$2"; CLONE_DIR="$2"; common_configure_trust',
      "_", join(repoRoot, "scripts/setup_common.sh"), fixture.productRoot], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR:");
    expect(result.stderr).toContain(scenario === "missing install root" ? "coord install/onboard" : "pnpm build");
  });

  it("adds Codex trust when the same path appears only as an unrelated value", () => {
    const fixture = product();
    // A home outside the parent, so the parent itself is trusted and checked.
    const home = join(product().workspaceRoot, "home");
    const parent = realpathSync(fixture.workspaceRoot);
    const config = join(home, ".codex/config.toml");
    mkdirSync(dirname(config), { recursive: true });
    const root = JSON.stringify(parent);
    const sync = () => syncAgentTrust({ agent: "codex", productRoot: fixture.productRoot, clone: join(parent, "myserver-codex"),
      home, options: { dryRun: false, log: () => undefined, changes: [] } });
    for (const before of [
      `sandbox_workspace_write.writable_roots = [${root}]\n`,
      `[mcp_servers.example]\ncwd = ${root}\n`,
      `[unrelated]\n${root} = "owner value"\nprojects = "owner value"\n`
    ]) {
      writeFileSync(config, before);
      sync();
      expect(readFileSync(config, "utf8")).toContain(before);
      expect(readFileSync(config, "utf8")).toContain(`[projects.${root}]`);
    }
    for (const before of [
      `projects = { ${root} = { trust_level = "untrusted" } }\n`,
      `projects.${root}.trust_level = "untrusted"\n`,
      `projects.${root} = { trust_level = "untrusted" }\n`,
      `[projects]\n${root} = { trust_level = "untrusted" }\n`,
      `[projects]\n${root}.trust_level = "untrusted"\n`
    ]) {
      writeFileSync(config, before);
      expect(sync).toThrow("Cannot update Codex trust");
      expect(readFileSync(config, "utf8")).toBe(before);
    }
  });

  it.each([
    ["claude", ".claude.json", '{"projects": []}'],
    ["antigravity", ".gemini/antigravity-cli/settings.json", '{"trustedWorkspaces": "invalid"}'],
    ["claude", ".claude.json", "not JSON"]
  ])("refuses malformed %s trust settings without replacing them", (agent, relative, contents) => {
    const fixture = product();
    const home = join(fixture.workspaceRoot, "home");
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    expect(() => syncAgentTrust({ agent, productRoot: fixture.productRoot, clone: fixture.productRoot, home,
      options: { dryRun: false, log: () => undefined, changes: [] } })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("advertises owner-driven manual work after installation", () => {
    const fixture = product();
    const output: string[] = [];
    installOnce(fixture, { log: (message) => output.push(message) });
    expect(output.join("")).toContain("coord manual --product ");
  });

  it("writes per-agent Terminal profile defaults into workspace config", () => {
    const fixture = product();
    const result = installOnce(fixture, {
      agents: ["claude", "codex", "cursor", "antigravity"]
    });
    const profiles = Object.fromEntries(
      readConfig(result.configPath).agents.map((agent) => [agent.id, agent.terminalProfile])
    );
    expect(profiles).toEqual({
      claude: "Claude 1",
      codex: "Codex 1",
      cursor: "Cursor 1",
      antigravity: "Gemini 1"
    });
  });

  it("keeps every vendor identity source manual-aware", () => {
    const branches: Record<string, string> = {
      claude: "claude/<name>",
      codex: "codex/<name>",
      cursor: "cursor/<name>",
      antigravity: "antigravity/<name>"
    };
    for (const [agent, branch] of Object.entries(branches)) {
      const source = readFileSync(join(repoRoot, `scripts/setup_${agent}.sh`), "utf8");
      expect(source).toContain("manual chat task");
      expect(source).toContain(branch);
      expect(source).toContain("fabricate coordinator evidence");
      expect(source).toContain("NEVER use --no-verify");
    }
  });

  it("leaves the product master with an empty git status", () => {
    const fixture = product();
    installOnce(fixture);
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
    expect(existsSync(join(fixture.productRoot, "githooks"))).toBe(false);
    expect(existsSync(join(fixture.productRoot, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(fixture.productRoot, ".gitignore"))).toBe(false);
  });

  it("leaves a fresh human clone with no coordination hooks and no new obligations", () => {
    const fixture = product();
    installOnce(fixture);

    const humanClone = join(fixture.workspaceRoot, "human");
    git(fixture.workspaceRoot, "clone", "-q", fixture.originPath, humanClone);
    git(humanClone, "config", "user.name", "Human");
    git(humanClone, "config", "user.email", "human@example.com");

    expect(existsSync(join(humanClone, ".git", "hooks", "coord-hooks.json"))).toBe(false);
    expect(existsSync(join(humanClone, ".git", "hooks", "pre-commit"))).toBe(false);

    // On main, with no agent prefix, and with no coordination anywhere on PATH.
    writeFileSync(join(humanClone, "notes.txt"), "human edit\n");
    git(humanClone, "add", "-A");
    const committed = tryGit(humanClone, "commit", "-qm", "just a normal commit");
    expect(committed.exitCode).toBe(0);
    expect(`${committed.stdout}${committed.stderr}`).not.toContain("coordination");
  });

  it("wires the agent clone rather than the product", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const clone = result.clones[0] as string;

    expect(existsSync(join(clone, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(clone, "start-claude.sh"))).toBe(true);
    const launcher = readFileSync(join(clone, "start-claude.sh"), "utf8");
    expect(launcher).toContain("Owner-driven manual mode");
    expect(launcher).toContain("claude/<name>");
    expect(launcher).toContain('exec "${coord_agent_cmd[@]}" --permission-mode auto');
    expect(git(clone, "config", "--local", "--get", "consensus.agentId")).toBe("claude");
    expect(git(clone, "config", "--local", "--get", "coord.installRoot")).toBe(repoRoot);
    expect(git(clone, "config", "--local", "--get", "coord.workspaceConfig")).toBe(result.configPath);
    expect(readConfig(result.configPath).prPolicy).toBe("coord-open-unmerged");
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).toContain("/start-*.sh");
    const agentsMd = readFileSync(join(clone, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("## Exact File List to be changed or deleted");
    expect(agentsMd).toContain("## Exact file list to be created");
    expect(agentsMd).toContain("## Reuse and Scope");
    expect(agentsMd).toContain("## Implementation discipline");
    for (const contract of ["A **plan review**", "A **code review**", "A **comparison**"]) {
      expect(agentsMd.indexOf(contract)).toBeLessThan(agentsMd.indexOf("## Implementation discipline"));
    }
    expect(agentsMd).toContain("action.md");
    expect(agentsMd).toContain("If `actionId` in the front matter has changed");
    expect(findAgentLanguageViolations(agentsMd)).toEqual([]);
    expect(agentsMd).toContain("skip-worktree");
    expect(agentsMd).toContain("owner-driven manual mode");
    expect(agentsMd).toContain("<agent>/<name>");
    expect(agentsMd).toContain("must not fabricate");
    expect(existsSync(join(clone, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(clone, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
  });

  it("seeds new agent clones from origin, not diverged local product main", () => {
    const fixture = product();
    writeFileSync(join(fixture.productRoot, "local-only.txt"), "should not seed clones\n");
    git(fixture.productRoot, "add", "local-only.txt");
    git(fixture.productRoot, "commit", "-qm", "local-only product commit");
    const result = installOnce(fixture);
    const clone = result.clones[0] as string;
    expect(existsSync(join(clone, "local-only.txt"))).toBe(false);
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(fixture.originPath, "rev-parse", "refs/heads/main"));
    expect(git(clone, "remote", "get-url", "origin")).toBe(fixture.originPath);
  });

  it("binds clones to a selected GitHub account without storing a token, keeps it on reinstall, and removes it on uninstall", () => {
    const fixture = product();
    const origin = "https://acct@github.com/example/myserver.git";
    const helper = "credential.https://github.com.helper";
    const coordHelper = `!'${join(repoRoot, "scripts/lib/node-runtime.sh")}' --fallback-node '${process.execPath}' '${join(repoRoot, "dist", "main.js")}' auth git-credential --account acct`;
    const helpers = () => tryGit(clone, "config", "--local", "--get-all", helper).stdout.split("\n").slice(0, -1);
    const result = installOnce(fixture, { origin, githubAccount: "acct" });
    const clone = result.clones[0] as string;
    expect(readConfig(result.configPath).github).toEqual({ account: "acct" });
    expect(git(clone, "config", "--local", "--get", "coord.githubAccount")).toBe("acct");
    expect(helpers()).toEqual(["", coordHelper]);
    expect(cloneGitHubWiringProblem(clone, "acct")).toBeNull();
    const launcher = readFileSync(join(clone, "start-claude.sh"), "utf8");
    expect(launcher).toContain('gh auth token --hostname github.com --user "$coord_github_account"');
    expect(launcher).not.toMatch(/GH_TOKEN=["']?[A-Za-z0-9_]{8,}/);

    // A repair run without the option keeps the selection (dry run: no fetch from github.com).
    expect(installOnce(fixture, { origin, dryRun: true }).changes).toEqual([]);

    // An owner's own helper survives a real repair (fetch redirected to the local origin) and
    // stays ahead of coord's reset; a later reset would defeat coord's helper and is reported.
    git(clone, "config", `url.${fixture.originPath}.insteadOf`, origin);
    git(clone, "config", "--local", "--add", helper, "cache --timeout=42");
    installOnce(fixture, { origin });
    expect(helpers()).toEqual(["cache --timeout=42", "", coordHelper]);
    expect(installOnce(fixture, { origin }).changes).toEqual([]);
    git(clone, "config", "--local", "--add", helper, "");
    expect(cloneGitHubWiringProblem(clone, "acct")).toMatch(/no effective GitHub credential helper/);

    uninstallOnce(fixture);
    expect(tryGit(clone, "config", "--local", "--get", "coord.githubAccount").exitCode).not.toBe(0);
    expect(helpers()).toEqual(["cache --timeout=42", ""]);
  });

  it("launches an agent with the selected account's token only after GitHub accepts it", () => {
    const fixture = product();
    const clone = installOnce(fixture, { origin: "https://github.com/example/myserver.git", githubAccount: "acct" }).clones[0] as string;
    const bin = join(fixture.workspaceRoot, "fake-bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(bin, "gh"), [
      "#!/usr/bin/env bash",
      'case "$1 $2" in',
      '  "auth token") [[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" && "$6" == acct ]] || exit 9; echo selected-token ;;',
      '  "api user") case "$FAKE_GH" in',
      "    ok) echo Acct ;; other) echo someone-else ;;",
      "    revoked) echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1 ;;",
      "    offline) echo 'error connecting to api.github.com' >&2; exit 1 ;;",
      "  esac ;;",
      "  *) exit 8 ;;",
      "esac", ""
    ].join("\n"), { mode: 0o755 });
    writeFileSync(join(bin, "claude"), '#!/usr/bin/env bash\necho "harness GH_TOKEN=$GH_TOKEN GITHUB_TOKEN=${GITHUB_TOKEN:-}"\n', { mode: 0o755 });
    const launch = (mode: string) => spawnSync("bash", [join(clone, "start-claude.sh")], {
      cwd: clone, encoding: "utf8",
      env: { ...process.env, HOME: join(fixture.workspaceRoot, "home"), PATH: `${bin}:${process.env.PATH ?? ""}`, COORD_NODE: join(bin, "node"),
        FAKE_GH: mode, GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient", COORD_ISSUE: "" }
    });

    for (const mode of ["ok", "offline"]) {
      const launched = launch(mode);
      expect(launched.status, launched.stderr).toBe(0);
      expect(launched.stdout).toContain("harness GH_TOKEN=selected-token GITHUB_TOKEN=\n");
    }
    expect(launch("offline").stderr).toContain("WARNING: could not verify GitHub account acct");
    const revoked = launch("revoked");
    expect(revoked.status).toBe(1);
    expect(revoked.stderr).toContain("GitHub authentication for acct has expired or been revoked.\nRun: coord auth login");
    const other = launch("other");
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("authenticates as someone-else");
    for (const refused of [revoked, other]) expect(refused.stdout).not.toContain("harness");
  });

  it("refuses a selected GitHub account on an SSH origin before creating any clone", () => {
    const fixture = product();
    expect(() => installOnce(fixture, { origin: "git@github.com:example/myserver.git", githubAccount: "acct" }))
      .toThrow("needs an https://github.com/");
    expect(existsSync(join(fixture.workspaceRoot, "myserver-claude"))).toBe(false);
  });
});

describe("coord install — idempotence", () => {
  it("makes no changes on a second run", () => {
    const fixture = product();
    const first = installOnce(fixture);
    expect(first.changes.length).toBeGreaterThan(0);

    const second = installOnce(fixture);
    expect(second.changes).toEqual([]);
  });

  it("dry-run reports work without performing it", () => {
    const fixture = product();
    const dry = installOnce(fixture, { dryRun: true });
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(existsSync(dry.configPath)).toBe(false);
    expect(existsSync(join(fixture.workspaceRoot, "myserver-claude"))).toBe(false);
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
  });
});

describe("coord install — emitted config", () => {
  it("uses a supplied tracking branch without creating an owner branch", () => {
    const fixture = product();
    const branch = "release/alpha";
    git(fixture.productRoot, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
    const result = installOnce(fixture, { baseBranch: branch });
    expect(readConfig(result.configPath).baseBranch).toBe(branch);
    expect(git(result.clones[0]!, "config", "--local", "consensus.sharedBranch")).toBe(branch);
    expect(tryGit(fixture.productRoot, "show-ref", "--verify", `refs/heads/${branch}`).exitCode).not.toBe(0);
    expect(git(fixture.productRoot, "branch", "--show-current")).toBe("main");
  });

  it.each(["bad..branch", "@{-1}", "missing/branch"])("rejects unusable branch %s before clone/config writes", (branch) => {
    const fixture = product();
    // @{-1} is revision shorthand, even when Git can resolve it to a valid branch.
    git(fixture.productRoot, "checkout", "-qb", "feature/work");
    expect(() => installOnce(fixture, { baseBranch: branch })).toThrow(
      branch === "missing/branch" ? /neither a local.*Fetch origin.*--base-branch/ : /Invalid shared branch/
    );
    expect(existsSync(join(fixture.coordRoot, "config.json"))).toBe(false);
    expect(existsSync(join(fixture.workspaceRoot, "myserver-claude"))).toBe(false);
  });

  it("is accepted by the driver's own config parser unchanged", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const config = readConfig(result.configPath);
    expect(config.project).toBe("myserver");
    expect(config.checks).toEqual(declaredChecks);
    expect(config.coordination?.installRoot).toBe(repoRoot);
    // Independent of `packageVersion`, which is what wrote this field.
    const expected = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string })
      .version;
    expect(config.coordination?.version).toBe(expected);
    expect(config.coordination?.vendored).toBe(false);
    expect(config.agents[0]?.launcher).toBe("start-claude.sh");
  });

  it("records the install stamp under coord-runtime, never in the product tree", () => {
    const fixture = product();
    const result = installOnce(fixture);
    expect(result.configPath.startsWith(fixture.coordRoot)).toBe(true);
    expect(result.configPath).toBe(join(fixture.coordRoot, "config.json"));
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
  });

  it("installs a workspace with announced empty checks when nobody declared any", () => {
    const fixture = product("plain");
    const io = silence();
    const result = installOnce(fixture, {
      declarePath: writeDeclaration(fixture.workspaceRoot, { verify: passingVerify }, "verify-only"),
      log: io.log
    });
    const config = readConfig(result.configPath);
    expect(config.checks).toEqual([]);
    expect(config.verify).toEqual(passingVerify);
    expect(io.lines.join("")).toContain("settings saved in:");
  });

  it("preserves saved check settings across reinstall instead of redetecting", () => {
    const fixture = product("plain");
    installOnce(fixture);
    const again = installOnce(fixture, {
      declarePath: writeDeclaration(fixture.workspaceRoot, { verify: passingVerify }, "verify-only-2")
    });
    expect(readConfig(again.configPath).checks).toEqual(declaredChecks);
  });

  it("does not silently overwrite a malformed existing workspace config", () => {
    const fixture = product("plain");
    const result = installOnce(fixture);
    writeFileSync(result.configPath, "{ not json\n");
    // Workspace selection routes around the unreadable file (doctor owns the
    // actionable report); the malformed bytes are never silently replaced.
    installOnce(fixture);
    expect(readFileSync(result.configPath, "utf8")).toBe("{ not json\n");
  });
});

describe("coord install — opt-in product changes", () => {
  it("writes the managed ignore block and AGENTS.md only with --write-product", () => {
    const fixture = product();
    installOnce(fixture, { writeProduct: true });
    const ignore = readFileSync(join(fixture.productRoot, ".gitignore"), "utf8");
    expect(ignore).toContain("coordination managed block");
    expect(ignore).toContain("/start-*.sh");
    expect(existsSync(join(fixture.productRoot, "AGENTS.md"))).toBe(true);
    expect(git(fixture.productRoot, "status", "--porcelain")).not.toBe("");
  });

  it("preserves human AGENTS.md text and appends the protocol block with --write-product", () => {
    const fixture = product();
    writeFileSync(join(fixture.productRoot, "AGENTS.md"), "# ours\n");
    installOnce(fixture, { writeProduct: true });
    const agents = readFileSync(join(fixture.productRoot, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# ours\n")).toBe(true);
    expect(agents).toContain("coordination protocol");
    expect(agents).toContain("## Exact File List to be changed or deleted");
    expect(agents).toContain("action.md");
  });
});

const uninstallOnce = (fixture: ProductFixture, overrides: Partial<Parameters<typeof uninstall>[0]> = {}) =>
  uninstall({
    coordRoot: fixture.coordRoot,
    productRoot: fixture.productRoot,
    deleteClones: false,
    wipeRuntime: false,
    deleteCoordination: false,
    force: false,
    dryRun: false,
    log: silence().log,
    home: join(fixture.workspaceRoot, "home"),
    ...overrides
  });

const expectCoordinationDeletionRefused = (
  fixture: ProductFixture,
  installed: ReturnType<typeof install>
): void => {
  const owned = readConfig(installed.configPath).coordination?.ownsInstallRoot === true;
  expect(() => uninstallOnce(fixture, { deleteCoordination: true })).toThrow(
    owned ? /test run \(VITEST is set\) must not delete/ : /not create the coordination checkout/
  );
  expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
};

describe("install deletion guard", () => {
  it("refuses to delete an install while VITEST is set", () => {
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: false,
        cwd: "/elsewhere",
        env: { VITEST: "true" }
      })
    ).toThrow(/test run \(VITEST is set\) must not delete/);
  });

  it("does not treat --force as a test-run escape hatch", () => {
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: true,
        cwd: "/elsewhere",
        env: { VITEST: "true" }
      })
    ).toThrow(/test run \(VITEST is set\) must not delete/);
  });

  it("allows a disposable install when COORD_ALLOW_DELETE_INSTALL is set", () => {
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: false,
        cwd: "/elsewhere",
        env: { VITEST: "true", COORD_ALLOW_DELETE_INSTALL: "1" }
      })
    ).not.toThrow();
  });

  it("refuses to delete the install that contains cwd unless --force", () => {
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: false,
        cwd: "/tmp/coord-install/src",
        env: {}
      })
    ).toThrow(/current working directory/);
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: true,
        cwd: "/tmp/coord-install/src",
        env: {}
      })
    ).not.toThrow();
  });
});

describe("coord uninstall", () => {
  it("clears the wiring and the workspace entry, and keeps the clone", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const clone = result.clones[0] as string;

    uninstallOnce(fixture);

    expect(existsSync(clone)).toBe(true);
    expect(existsSync(join(clone, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(clone, ".git", "hooks", "coord-hooks.json"))).toBe(false);
    expect(existsSync(join(clone, "start-claude.sh"))).toBe(false);
    expect(tryGit(clone, "config", "--local", "--get", "consensus.agentId").exitCode).not.toBe(0);
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).not.toContain("coordination managed block");
    expect(existsSync(result.configPath)).toBe(false);
  });

  it("installs the Claude status-line tee in the ignored clone layer and removes it on uninstall", () => {
    const fixture = product();
    const home = join(fixture.workspaceRoot, "owner-home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo owner" } }));
    const clone = installOnce(fixture, { home }).clones[0] as string;
    const local = join(clone, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(local, "utf8")) as { statusLine?: { command?: string }; hooks?: unknown };
    expect(settings.statusLine?.command).toBe(join(clone, ".claude", "coord-statusline.sh"));
    expect(readFileSync(join(clone, ".claude", "coord-statusline.sh"), "utf8")).toContain("'echo owner'");
    expect(git(clone, "status", "--porcelain")).toBe("");
    uninstallOnce(fixture, { home });
    expect(existsSync(join(clone, ".claude", "coord-statusline.sh"))).toBe(false);
    expect(existsSync(local) && "statusLine" in (JSON.parse(readFileSync(local, "utf8")) as object)).toBe(false);
  });

  it("removes the managed product ignore block only when the install wrote it", () => {
    const written = product();
    writeFileSync(join(written.productRoot, ".gitignore"), "# product's own\nbuild/\n");
    installOnce(written, { writeProduct: true });
    uninstallOnce(written);
    const remaining = readFileSync(join(written.productRoot, ".gitignore"), "utf8");
    expect(remaining).toContain("build/");
    expect(remaining).not.toContain("coordination managed block");

    const untouched = product();
    writeFileSync(join(untouched.productRoot, ".gitignore"), "# product's own\nbuild/\n");
    git(untouched.productRoot, "add", "-A");
    git(untouched.productRoot, "commit", "-qm", "add ignore");
    installOnce(untouched);
    uninstallOnce(untouched);
    expect(readFileSync(join(untouched.productRoot, ".gitignore"), "utf8")).toBe("# product's own\nbuild/\n");
  });

  it("refuses to delete a dirty clone without --force", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const clone = result.clones[0] as string;
    writeFileSync(join(clone, "cmd", "extra.go"), "package main\n");
    git(clone, "add", "-A");

    expect(() => uninstallOnce(fixture, { deleteClones: true })).toThrow(/uncommitted changes/);
    expect(existsSync(clone)).toBe(true);

    uninstallOnce(fixture, { deleteClones: true, force: true });
    expect(existsSync(clone)).toBe(false);
  });

  it("refuses --delete-coordination for a checkout it did not create", () => {
    const fixture = product();
    const installed = installOnce(fixture);
    expectCoordinationDeletionRefused(fixture, installed);
  });
});

describe("coord install — preflight before effects", () => {
  it("rejects a malformed or duplicated agent id before creating anything", () => {
    const fixture = product();
    expect(() => installOnce(fixture, { agents: ["../../escaped"] })).toThrow(/not a valid agent id/);
    expect(() => installOnce(fixture, { agents: ["claude", "claude"] })).toThrow(/more than once/);
    expect(() => installOnce(fixture, { agents: ["nosuchagent"] })).toThrow(/No launch command/);
    expect(readdirSync(fixture.workspaceRoot).sort()).toEqual(["d.json", "declare.json", "myserver", "myserver-origin.git"].filter((entry) => readdirSync(fixture.workspaceRoot).includes(entry)));
    expect(existsSync(join(fixture.workspaceRoot, "escaped"))).toBe(false);
    expect(existsSync(join(fixture.workspaceRoot, "myserver-claude"))).toBe(false);
  });

  it("installs a no-checks product and wires its clone", () => {
    const fixture = product("plain");
    const result = installOnce(fixture, {
      declarePath: writeDeclaration(fixture.workspaceRoot, { verify: passingVerify }, "no-checks")
    });
    expect(readConfig(result.configPath).checks).toEqual([]);
    expect(existsSync(join(fixture.workspaceRoot, "myserver-claude"))).toBe(true);
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
  });

  it("refuses ambiguous detected plans before creating anything", () => {
    const fixture = product("plain");
    writeFileSync(join(fixture.productRoot, "CMakePresets.json"), JSON.stringify({
      configurePresets: [{ name: "a" }], buildPresets: [{ name: "a" }], testPresets: [{ name: "a" }]
    }));
    mkdirSync(join(fixture.productRoot, "scripts"), { recursive: true });
    writeFileSync(join(fixture.productRoot, "scripts", "check.sh"), "#!/bin/sh\ntrue\n");
    git(fixture.productRoot, "add", "-A");
    git(fixture.productRoot, "commit", "-qm", "add competing plans");
    expect(() =>
      installOnce(fixture, {
        declarePath: writeDeclaration(fixture.workspaceRoot, { verify: passingVerify }, "ambiguous")
      })
    ).toThrow(/Several runnable build\/test plans/);
    expect(existsSync(join(fixture.workspaceRoot, "myserver-claude"))).toBe(false);
  });

  it("refuses to adopt a directory that is not a clone of this product", () => {
    const notARepo = product();
    const path = join(notARepo.workspaceRoot, "myserver-claude");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "UNRELATED.txt"), "someone else's files\n");
    expect(() => installOnce(notARepo)).toThrow(/not the root of a git worktree/);
    expect(readdirSync(path)).toEqual(["UNRELATED.txt"]);

    const wrongOrigin = product();
    const stranger = join(wrongOrigin.workspaceRoot, "myserver-claude");
    git(wrongOrigin.workspaceRoot, "init", "-q", stranger);
    git(stranger, "remote", "add", "origin", "https://example.com/other.git");
    expect(() => installOnce(wrongOrigin)).toThrow(/not of /);
  });

  it("leaves no staging file in the clone during a dry run", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const dry = installOnce(fixture, { dryRun: true });
    expect(dry.changes).toEqual([]);
    expect(readdirSync(result.clones[0] as string).filter((entry) => entry.includes("coord-tmp"))).toEqual([]);
  });
});

describe("coord install — reinstall", () => {
  it("refreshes Claude's native preference in installed launchers with old Node first", () => {
    const fixture = product("plain"), home = join(fixture.workspaceRoot, "home");
    const clone = installOnce(fixture, { home }).clones[0] as string;
    const ownerBin = join(home, ".nvm/versions/node/v16.18.0/bin");
    const coordBin = join(fixture.workspaceRoot, "coord-bin"), localBin = join(home, ".local/bin");
    for (const dir of [ownerBin, coordBin, localBin]) mkdirSync(dir, { recursive: true });
    symlinkSync(process.execPath, join(coordBin, "node"));
    writeFileSync(join(ownerBin, "node"), '#!/bin/sh\necho v16.18.0\n', { mode: 0o755 });
    writeFileSync(join(ownerBin, "claude"), '#!/bin/sh\necho "Error: claude native binary not installed." >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(localBin, "claude"), '#!/bin/sh\nprintf "%s|%s\\n" "$0" "$(node --version)"\n', { mode: 0o755 });
    const path = join(clone, "start-claude.sh");
    const current = readFileSync(path, "utf8");
    // Simulate the pre-#243 embedded helper left by an earlier installation.
    const stale = current.replace(' "$1" == claude ||', "");
    expect(stale).not.toBe(current);
    writeFileSync(path, stale);
    const launch = () => spawnSync("/bin/bash", [path], {
      cwd: clone, encoding: "utf8",
      env: { ...process.env, HOME: home, NVM_DIR: join(home, ".nvm"),
        PATH: `${ownerBin}:${coordBin}:/usr/bin:/bin`, COORD_NODE: join(coordBin, "node"), COORD_ISSUE: "" }
    });
    const broken = launch();
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain("Error: claude native binary not installed.");

    installOnce(fixture, { home });
    const repaired = launch();
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain(`${join(localBin, "claude")}|v16.18.0`);
    expect(repaired.stderr).not.toContain("claude native binary not installed");
  });

  it("fast-forwards a clean clone and refuses to rewrite a dirty one", () => {
    const fixture = product();
    const clone = installOnce(fixture).clones[0] as string;
    const before = git(clone, "rev-parse", "HEAD");

    writeFileSync(join(fixture.productRoot, "cmd", "later.go"), "package main\n");
    git(fixture.productRoot, "add", "-A");
    git(fixture.productRoot, "commit", "-qm", "later work");
    git(fixture.productRoot, "push", "-q", "origin", "main");

    installOnce(fixture);
    expect(git(clone, "rev-parse", "HEAD")).not.toBe(before);

    writeFileSync(join(clone, "dirty.txt"), "uncommitted\n");
    const advanced = git(clone, "rev-parse", "HEAD");
    installOnce(fixture);
    expect(git(clone, "rev-parse", "HEAD")).toBe(advanced);
    expect(readFileSync(join(clone, "dirty.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("refreshes every stamp field that the run's options changed", () => {
    const fixture = product();
    installOnce(fixture);
    const result = installOnce(fixture, { writeProduct: true });
    expect(readConfig(result.configPath).coordination?.wroteProductIgnore).toBe(true);

    uninstallOnce(fixture);
    expect(readFileSync(join(fixture.productRoot, ".gitignore"), "utf8")).not.toContain("coordination managed block");
    expect(existsSync(join(fixture.productRoot, "AGENTS.md"))).toBe(false);
  });
});

describe("coord uninstall — scope", () => {
  it("keeps owner-authored material in the workspace directory", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const plans = join(dirname(result.configPath), ".plans", "issue-7");
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, "plan.md"), "# owner-authored plan\n");

    uninstallOnce(fixture);
    expect(existsSync(result.configPath)).toBe(false);
    expect(readFileSync(join(plans, "plan.md"), "utf8")).toContain("owner-authored");
  });

  it("decides the dirty-clone refusal before unwiring anything", () => {
    const fixture = product();
    const result = install({
      home: null,
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      coordRoot: fixture.coordRoot,
      agents: ["claude", "codex"],
      profile: "consensus",
      declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }, "two"),
      writeProduct: false,
      vendor: false,
      bootstrap: false,
      dryRun: false,
      log: silence().log
    });
    const [claude, codex] = result.clones as [string, string];
    writeFileSync(join(codex, "dirty.txt"), "uncommitted\n");

    expect(() => uninstallOnce(fixture, { deleteClones: true })).toThrow(/Nothing has been changed/);
    expect(existsSync(claude)).toBe(true);
    expect(existsSync(join(claude, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(git(claude, "config", "--local", "--get", "consensus.agentId")).toBe("claude");
  });

  it("flat --wipe-runtime deletes the outer root when it is the sole workspace", () => {
    const fixture = product();
    installOnce(fixture);
    mkdirSync(join(fixture.coordRoot, "issue-1"));
    mkdirSync(join(fixture.coordRoot, "mirror.git"));
    uninstallOnce(fixture, { wipeRuntime: true });
    expect(existsSync(fixture.coordRoot)).toBe(false);
  });

  it("flat --wipe-runtime never deletes nested siblings when forced on a shared root", () => {
    const first = product();
    installOnce(first);
    const second = makeProduct("go", "otherserver");
    fixtures.push(second);
    install({
      home: null,
      installRoot: repoRoot,
      productRoot: second.productRoot,
      coordRoot: first.coordRoot,
      agents: ["codex"],
      profile: "solo",
      declarePath: writeDeclaration(second.workspaceRoot, { checks: declaredChecks, verify: passingVerify }),
      writeProduct: false,
      vendor: false,
      bootstrap: false,
      dryRun: false,
      log: silence().log
    });
    // Two products share one runtime; both workspaces live under it.
    const otherWorkspace = dirname(nestedConfigPath(first.coordRoot, "otherserver"));
    expect(existsSync(otherWorkspace)).toBe(true);
    mkdirSync(join(first.coordRoot, "issue-1"));
    mkdirSync(join(first.coordRoot, "mirror.git"));

    expect(() => uninstallOnce(first, { wipeRuntime: true })).toThrow(/other workspace/);
    expect(existsSync(otherWorkspace)).toBe(true);
    uninstallOnce(first, { wipeRuntime: true, force: true });
    expect(existsSync(first.coordRoot)).toBe(true);
    expect(existsSync(nestedConfigPath(first.coordRoot, "otherserver"))).toBe(true);
    expect(existsSync(join(first.coordRoot, "issue-1"))).toBe(false);
    expect(existsSync(join(first.coordRoot, "mirror.git"))).toBe(false);
  });

  it("refuses --delete-coordination because no install owns the checkout", () => {
    const fixture = product();
    const installed = installOnce(fixture, { bootstrap: false });
    expectCoordinationDeletionRefused(fixture, installed);
  });
});

describe("completion mailbox wiring", () => {
  /**
   * The grant is resolved by the generated launcher at exec time, not baked in
   * at install: `githooks/post-merge` regenerates that file with no issue
   * number in hand, so a baked-in path would disagree with whichever writer ran
   * last. The clone key is how both writers reach the same mailbox.
   */
  it("records the mailbox root in the clone and grants only the current drop", () => {
    const fixture = product();
    const result = installOnce(fixture, { agents: ["claude", "codex"] });
    const config = JSON.parse(readFileSync(result.configPath, "utf8")) as {
      completesRoot?: string;
      coordination?: { completesRoot?: string };
    };
    const mailbox = config.completesRoot as string;

    expect(mailbox).toBeDefined();
    expect(isAbsolute(mailbox)).toBe(true);
    // A sibling, not a child: granting a path inside the runtime directory would grant
    // cursors.json and every peer's action.md along with it.
    expect(mailbox.startsWith(`${resolve(fixture.coordRoot)}/`)).toBe(false);
    expect(existsSync(mailbox)).toBe(true);
    expect(config.coordination?.completesRoot).toBe(mailbox);

    for (const clone of result.clones) {
      expect(git(clone, "config", "--local", "--get", "coord.completesRoot")).toBe(mailbox);
    }

    const launcher = readFileSync(join(result.clones[0] as string, "start-claude.sh"), "utf8");
    expect(launcher).toContain("--add-dir");
    expect(launcher).toContain('coord_drop="$coord_completes_root/issue-$COORD_ISSUE/claude"');
    // Never the whole mailbox (peers' receipts) and never the runtime.
    expect(launcher).not.toContain(`--add-dir "${mailbox}"`);
    expect(launcher).not.toContain(resolve(fixture.coordRoot));
  });

  it("installs and restores Codex automatic approval review without blanket filesystem access", () => {
    const fixture = product();
    const result = installOnce(fixture, { agents: ["codex"] });
    const path = join(result.clones[0] as string, "start-codex.sh");
    const launcher = readFileSync(path, "utf8");
    expect(launcher).not.toContain("danger-full-access");
    expect(launcher).toContain("--approve-for-me");
    expect(launcher).not.toContain("--sandbox");
    expect(launcher).not.toContain("--ask-for-approval");
    writeFileSync(path, launcher.replace("--approve-for-me", "--ask-for-approval never --sandbox workspace-write"));
    installOnce(fixture, { agents: ["codex"] });
    expect(readFileSync(path, "utf8")).toBe(launcher);
  });

  /**
   * Executes the real generated launchers against stub harnesses and asserts the
   * exact argv. Asserting the rendered text alone cannot see an expansion that
   * aborts, a flag that lands in the wrong order, or a path with a space that
   * splits into two arguments — all of which reach the vendor, not the file.
   */
  it("passes each harness exactly its own current drop, and nothing in manual mode", () => {
    const fixture = product("plain");
    // A space in the path: the grant has to survive as one argument.
    const completesRoot = join(fixture.workspaceRoot, "completion mailbox");
    const agents = ["claude", "codex", "cursor", "antigravity"] as const;
    // The Antigravity launcher prepends $HOME/.local/bin, so HOME must point at
    // the fixture or the machine's real agy would shadow the stub.
    const home = join(fixture.workspaceRoot, "home");
    const result = installOnce(fixture, { agents, completesRoot, home });
    const bin = join(fixture.workspaceRoot, "stub-bin");
    mkdirSync(bin);
    // Keep runtime selection beside the fake vendors, never the host installs.
    symlinkSync(process.execPath, join(bin, "node"));
    for (const command of ["claude", "codex", "agent", "agy"]) {
      writeFileSync(join(bin, command), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CAPTURE"\n', { mode: 0o755 });
    }

    const expected = {
      claude: ["--permission-mode", "auto"],
      codex: ["-c", "check_for_update_on_startup=false", "-c", "tui.vim_mode_default=false", "--approve-for-me", "--no-alt-screen", "--no-daemon"],
      cursor: ["--sandbox", "enabled"],
      antigravity: ["--mode", "accept-edits", "--dangerously-skip-permissions"]
    } as const;

    for (const [index, agent] of agents.entries()) {
      const clone = result.clones[index] as string;
      const drop = join(completesRoot, "issue-17", agent);
      mkdirSync(drop, { recursive: true });
      const responses = join(fixture.coordRoot, "issue-17", "agents", agent, "responses");
      mkdirSync(responses, { recursive: true });
      // Created before any harness starts, because the launcher resolves grants
      // once at exec and a directory appearing later can never reach it.
      const inputs = join(fixture.coordRoot, "issue-17", "inputs");
      const worktrees = join(fixture.coordRoot, "issue-17", "worktrees");
      mkdirSync(inputs, { recursive: true });
      mkdirSync(worktrees, { recursive: true });
      const capture = join(fixture.workspaceRoot, `${agent}.args`);
      // /bin/bash, not `bash`: macOS ships 3.2, where expanding an empty array
      // as "${a[@]}" under `set -u` aborts. A test that resolves a newer bash
      // from PATH cannot see that, and the launcher runs under whatever the
      // machine has.
      execFileSync("/bin/bash", [join(clone, `start-${agent}.sh`)], {
        cwd: clone,
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, COORD_NODE: join(bin, "node"), COORD_ISSUE: "17", CAPTURE: capture },
        stdio: "ignore"
      });
      const argv = readFileSync(capture, "utf8").trimEnd().split("\n");
      expect(argv).toEqual([
        ...expected[agent],
        "--add-dir",
        drop,
        "--add-dir",
        responses,
        "--add-dir",
        inputs,
        "--add-dir",
        worktrees
      ]);
      // Never the runtime root as a grant, never the whole mailbox, never a peer's drop.
      expect(argv).not.toContain(fixture.coordRoot);
      expect(argv).not.toContain(completesRoot);
      expect(argv).not.toContain(join(completesRoot, "issue-17", agents[(index + 1) % agents.length]));
      expect(argv).not.toContain(join(fixture.coordRoot, "issue-17", "agents", agents[(index + 1) % agents.length], "responses"));
    }

    // Manual mode: no issue, so no grant — and the harness must still start.
    for (const [index, agent] of ["claude", "codex"].entries()) {
      const clone = result.clones[index] as string;
      const manual = join(fixture.workspaceRoot, `${agent}-manual.args`);
      execFileSync("/bin/bash", [join(clone, `start-${agent}.sh`)], {
        cwd: clone,
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, COORD_NODE: join(bin, "node"), COORD_ISSUE: "", CAPTURE: manual },
        stdio: "ignore"
      });
      expect(readFileSync(manual, "utf8").trimEnd().split("\n")).toEqual(expected[agent as "claude" | "codex"]);
    }
  });

  /**
   * `scripts/setup_antigravity.sh` writes a user-global settings file that no
   * `coord` command reads back, so an upgrade repairs it or nothing does. Runs
   * the script's own embedded node program against a settings.json from before
   * the mailbox existed.
   */
  it("withdraws the peer-clone trust and non-workspace access an older Antigravity install kept", () => {
    const fixture = product();
    const script = readFileSync(join(repoRoot, "scripts", "setup_antigravity.sh"), "utf8");
    const program = /^node - "\$SETTINGS_FILE" "\$CLONE_DIR" <<'EOF'\n([\s\S]*?)\nEOF$/m.exec(script)?.[1];
    expect(program).toBeDefined();
    // .cjs: the embedded program uses require(), and this package is type: module.
    const programPath = join(fixture.workspaceRoot, "antigravity-settings.cjs");
    writeFileSync(programPath, program as string);

    const clone = join(fixture.workspaceRoot, "myapp-antigravity");
    const settingsPath = join(fixture.workspaceRoot, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        // What an install from before this issue left behind.
        allowNonWorkspaceAccess: true,
        permissions: { allow: ["command(ls)"] },
        trustedWorkspaces: [
          join(fixture.workspaceRoot, "myapp-claude"),
          join(fixture.workspaceRoot, "myapp-codex"),
          clone,
          join(fixture.workspaceRoot, "owner-notes")
        ]
      })
    );

    execFileSync("node", [programPath, settingsPath, clone], { stdio: "ignore" });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      allowNonWorkspaceAccess: boolean;
      permissions: { allow: string[] };
      trustedWorkspaces: string[];
    };

    // A user-global grant of non-workspace access hands back the coordinator
    // runtime the mailbox exists to keep out; a launcher flag cannot narrow it.
    expect(settings.allowNonWorkspaceAccess).toBe(false);
    // Old per-peer entries are still removed. Parent trust is now established
    // separately by the shared setup helper; permission settings stay separate.
    expect(settings.trustedWorkspaces).not.toContain(join(fixture.workspaceRoot, "myapp-claude"));
    expect(settings.trustedWorkspaces).not.toContain(join(fixture.workspaceRoot, "myapp-codex"));
    // Its own clone stays, and owner-authored entries are not this script's to
    // delete.
    expect(settings.trustedWorkspaces).toContain(clone);
    expect(settings.trustedWorkspaces).toContain(join(fixture.workspaceRoot, "owner-notes"));
    expect(settings.permissions.allow).toContain("command(ls)");
  });

  it("refuses a second workspace that would share one mailbox", () => {
    const first = product();
    const second = product();
    const shared = join(first.workspaceRoot, "shared-mailbox");
    installOnce(first, { completesRoot: shared });
    // Same receipts directory for a different workspace: issue-42/claude/complete
    // would be one file for two products, and the last writer would win.
    expect(() => installOnce(second, { completesRoot: shared })).toThrow(/already holds receipts for/);
  });

  it("uninstall clears the mailbox key so a stale grant cannot survive", () => {
    const fixture = product();
    const installed = installOnce(fixture, { agents: ["claude"] });
    uninstallOnce(fixture);
    expect(tryGit(installed.clones[0] as string, "config", "--local", "--get", "coord.completesRoot").exitCode).not.toBe(
      0
    );
  });
});

/**
 * The shim is what stops an agent re-deriving checkout state coordination
 * already owns. Asserting the rendered text is not enough: what matters is the
 * exit code real git invocations get, so these run the generated file.
 */
const shimEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.COORD_GIT_DELEGATE;
  return env;
};

describe("generated git shim", () => {
  it("check mode decides without running an allowed real Git command, including delegate/manual branches", () => {
    const f = product();
    const marker = join(f.workspaceRoot, "real-git-ran");
    const fake = join(f.workspaceRoot, "fake-git");
    // The policy itself may read clone config (to resolve the runtime); only an
    // allowed command actually running would leave the marker.
    writeFileSync(fake, `#!/bin/sh\n[ "$1" = config ] && exit 1\nprintf ran > '${marker}'\n`, { mode: 0o700 });
    const shim = join(f.productRoot, ".coord/bin/git");
    execFileSync("bash", ["-c", '. "$1"; write_git_wrapper "$2" "$3" "$4"', "_",
      join(repoRoot, "scripts/lib/launcher.sh"), shim, fake, realpathSync(f.productRoot)]);
    const check = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(shim, args, {
      cwd: f.productRoot, encoding: "utf8", env: { ...shimEnv(), COORD_ISSUE: "42", COORD_GIT_POLICY_CHECK: "1", ...env }
    });
    expect(check(["status"]).status).toBe(2);
    for (const result of [check(["log", "-1"]), check(["push"]), check(["-C", f.workspaceRoot, "status"]),
      check(["status"], { COORD_ISSUE: "" }), check(["status"], { COORD_GIT_DELEGATE: "1" })]) {
      expect(result.status).toBe(0); expect(result.stdout).toBe("");
    }
    expect(existsSync(marker)).toBe(false);
    expect(check(["log"], { COORD_GIT_POLICY_CHECK: "" }).status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
  const runGit = (
    clone: string,
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv = {}
  ): { status: number; stderr: string } => {
    const result = execFileSync("/bin/bash", ["-c", 'PATH="$1:$PATH"; shift; git "$@"; echo "exit=$?"', "_",
      join(clone, ".coord", "bin"), ...args], {
      cwd,
      encoding: "utf8",
      // `git commit` in a coord-launched session runs through this very shim,
      // which exports COORD_GIT_DELEGATE=1 before exec'ing real git. Inherited,
      // it makes the shim under test delegate instead of deciding, so the
      // refusal cases silently pass through. The suite runs inside that hook.
      env: { ...shimEnv(), COORD_ISSUE: "42", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const match = /exit=(\d+)\s*$/.exec(result);
    return { status: Number(match?.[1] ?? -1), stderr: "" };
  };
  // A live automated issue: COORD_ISSUE alone names one only while its runtime exists.
  const liveIssue = (clone: string): void => {
    mkdirSync(join(dirname(git(clone, "config", "--get", "coord.workspaceConfig")), "issue-42"), { recursive: true });
  };

  it("installs an untracked shim the launcher puts on PATH", () => {
    const fixture = product();
    const result = installOnce(fixture, { agents: ["claude"] });
    const clone = result.clones[0] as string;
    const shim = join(clone, ".coord", "bin", "git");

    expect(existsSync(shim)).toBe(true);
    const body = readFileSync(shim, "utf8");
    const realGit = /^REAL_GIT="(.+)"$/m.exec(body)?.[1] as string;
    expect(isAbsolute(realGit)).toBe(true);
    // Resolved from a PATH without .coord/bin, or the shim would invoke itself.
    expect(realGit).not.toContain("/.coord/bin/");
    expect(/^COORD_CLONE="(.+)"$/m.exec(body)?.[1]).toBeDefined();

    // Untracked and excluded, so the clone stays clean.
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).toContain(".coord/");
    expect(git(clone, "status", "--porcelain")).toBe("");
    // A sandbox-local pnpm store is cache, so it must not dirty the clone either.
    mkdirSync(join(clone, ".pnpm-store", "v10"), { recursive: true });
    writeFileSync(join(clone, ".pnpm-store", "v10", "index"), "cache\n");
    expect(git(clone, "status", "--porcelain")).toBe("");

    const launcher = readFileSync(join(clone, "start-claude.sh"), "utf8");
    expect(launcher).toContain('.coord/bin:$PATH');
    // The startup read is exactly what the shim now refuses.
    expect(launcher).not.toContain("git status -sb");
  });

  it("refuses the reads coordination owns and delegates everything else", () => {
    const fixture = product();
    const clone = installOnce(fixture, { agents: ["claude"] }).clones[0] as string;
    liveIssue(clone);
    const head = git(clone, "rev-parse", "HEAD");
    const tracked = git(clone, "ls-tree", "--name-only", "HEAD").split("\n")[0] as string;

    for (const args of [["status"], ["status", "--porcelain"], ["diff"], ["--no-pager", "diff"], ["-C", ".", "status"]]) {
      expect(runGit(clone, clone, args).status, args.join(" ")).toBe(2);
    }
    // Open-ended reconnaissance is refused; the exact pinned peer read stays as
    // the documented fallback for a file the coordinator could not export.
    expect(runGit(clone, clone, ["show", "HEAD"]).status).toBe(2);
    expect(runGit(clone, clone, ["show", `${head}:${tracked}`]).status).toBe(0);

    // Publishing must never be blocked, and the installed hooks run under the
    // delegate guard, so a commit that triggers them still completes.
    for (const args of [["rev-parse", "HEAD"], ["log", "--oneline", "-1"], ["config", "--get", "consensus.agentId"]]) {
      expect(runGit(clone, clone, args).status, args.join(" ")).toBe(0);
    }
  });

  it("refuses even when the suite itself runs under a delegated git", () => {
    const fixture = product();
    const clone = installOnce(fixture, { agents: ["claude"] }).clones[0] as string;
    liveIssue(clone);
    const prior = process.env.COORD_GIT_DELEGATE;
    try {
      process.env.COORD_GIT_DELEGATE = "1";
      expect(runGit(clone, clone, ["status"]).status).toBe(2);
    } finally {
      if (prior === undefined) delete process.env.COORD_GIT_DELEGATE;
      else process.env.COORD_GIT_DELEGATE = prior;
    }
  });

  /**
   * The reason the shim resolves the target repository instead of refusing on
   * the subcommand alone. A product's own tooling shells out to git against
   * other repositories, and this repository's fast suite does exactly that; a
   * blanket block breaks `pnpm check:fast`, which is the check an agent has to
   * pass before it can commit anything.
   */
  it("stays out of the way of manual mode and of other repositories", () => {
    const fixture = product();
    const clone = installOnce(fixture, { agents: ["claude"] }).clones[0] as string;
    const elsewhere = fixture.productRoot;

    expect(runGit(clone, clone, ["status"], { COORD_ISSUE: "" }).status).toBe(0);
    expect(runGit(clone, clone, ["status"], { COORD_GIT_DELEGATE: "1" }).status).toBe(0);
    expect(runGit(clone, elsewhere, ["status", "--porcelain"]).status).toBe(0);
    expect(runGit(clone, clone, ["-C", elsewhere, "status", "--porcelain"]).status).toBe(0);
    expect(runGit(clone, elsewhere, ["--git-dir", join(elsewhere, ".git"), "status", "--porcelain"]).status).toBe(0);
  });

  /**
   * The pinned peer read is the fallback for a file the coordinator could not
   * export. Once the action lists the files, the same read is the expensive
   * route to bytes already on disk — the repetition this change exists to stop.
   */
  it("blocks the pinned peer read only once the action lists the files", () => {
    const fixture = product();
    const clone = installOnce(fixture, { agents: ["claude"] }).clones[0] as string;
    const head = git(clone, "rev-parse", "HEAD");
    const tracked = git(clone, "ls-tree", "--name-only", "HEAD").split("\n")[0] as string;
    const pinned = ["show", `${head}:${tracked}`];

    const configPath = git(clone, "config", "--local", "--get", "coord.workspaceConfig");
    const actionDir = join(dirname(configPath), "issue-42", "agents", "claude");
    mkdirSync(actionDir, { recursive: true });
    const action = join(actionDir, "action.md");

    // No action yet, and an action without the section: the fallback stands.
    expect(runGit(clone, clone, pinned).status).toBe(0);
    writeFileSync(action, "body\n\n## Repo context\n\n\"docs/repo-map.md\"\n");
    expect(runGit(clone, clone, pinned).status).toBe(0);

    // The coordinator exported the files; the expensive route closes.
    writeFileSync(action, "body\n\n## Bound input files\n\n- plan from codex: \"/tmp/x\"\n");
    expect(runGit(clone, clone, pinned).status).toBe(2);

    // But `<rev>:<path>` against this clone's own history is an ordinary file
    // read, not peer reconnaissance, and a product's tooling makes it — this
    // repository's own language test reads HEAD:AGENTS.md that way.
    expect(runGit(clone, clone, ["show", `HEAD:${tracked}`]).status).toBe(0);

    // A partial export keeps the fallback open for what is missing.
    writeFileSync(
      action,
      "body\n\n## Bound input files\n\nNot every bound input could be exported; `git show <sha>:<path>` remains available for the rest.\n\n- plan from codex: \"/tmp/x\"\n"
    );
    expect(runGit(clone, clone, pinned).status).toBe(0);

    // Manual mode and the delegate guard are unaffected either way.
    expect(runGit(clone, clone, pinned, { COORD_ISSUE: "" }).status).toBe(0);
    expect(runGit(clone, clone, pinned, { COORD_GIT_DELEGATE: "1" }).status).toBe(0);
  });

  /**
   * Unlike the launcher, which may carry owner customisation, the shim is
   * coordinator-owned policy: a clone left holding an older copy keeps
   * enforcing rules this install has already withdrawn.
   */
  it("replaces its own stale copy but never a file it did not write", () => {
    const fixture = product();
    const clone = installOnce(fixture, { agents: ["claude"] }).clones[0] as string;
    const shim = join(clone, ".coord", "bin", "git");
    const canonical = readFileSync(shim, "utf8");

    writeFileSync(shim, canonical.replace("# coord-managed-git-wrapper", "# coord-managed-git-wrapper\n# stale"));
    installOnce(fixture, { agents: ["claude"] });
    expect(readFileSync(shim, "utf8")).toBe(canonical);

    writeFileSync(shim, "#!/bin/sh\necho someone else wrote this\n");
    installOnce(fixture, { agents: ["claude"] });
    expect(readFileSync(shim, "utf8")).toContain("someone else wrote this");
  });
});

describe("generated agent launchers", () => {
  it.each([
    { pnpm: true, corepack: true, lockfile: true },
    { pnpm: true, corepack: false, lockfile: true },
    { pnpm: false, corepack: true, lockfile: true },
    { pnpm: true, corepack: true, lockfile: false }
  ])("uses native pnpm without Corepack (pnpm=$pnpm, corepack=$corepack, lockfile=$lockfile)", (available) => {
    const fixture = product("plain");
    const home = join(fixture.workspaceRoot, "home");
    const clone = installOnce(fixture, { home }).clones[0] as string;
    const bin = join(fixture.workspaceRoot, "bin");
    const pnpmLog = join(fixture.workspaceRoot, "pnpm.log");
    const corepackLog = join(fixture.workspaceRoot, "corepack.log");
    const capture = join(fixture.workspaceRoot, "claude.args");
    mkdirSync(bin);
    // Expose only launcher prerequisites; host pnpm/Corepack installs must not
    // leak into the cases that deliberately omit them.
    for (const command of ["dirname", "git"]) {
      const executable = execFileSync("/bin/bash", ["-c", 'command -v "$1"', "_", command], { encoding: "utf8" }).trim();
      symlinkSync(executable, join(bin, command));
    }
    symlinkSync(process.execPath, join(bin, "node"));
    if (available.lockfile) writeFileSync(join(clone, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    if (available.pnpm) writeFileSync(join(bin, "pnpm"),
      '#!/bin/sh\nprintf "%s\\n" "$PWD" "$*" >"$PNPM_LOG"\necho 12.15.0\n', { mode: 0o755 });
    if (available.corepack) writeFileSync(join(bin, "corepack"),
      '#!/bin/sh\necho invoked >"$COREPACK_LOG"\nexit 42\n', { mode: 0o755 });
    writeFileSync(join(bin, "claude"), '#!/bin/sh\nprintf "%s\\n" "$@" >"$CAPTURE"\n', { mode: 0o755 });

    const launched = spawnSync("/bin/bash", [join(clone, "start-claude.sh")], {
      cwd: clone,
      encoding: "utf8",
      env: {
        ...process.env, HOME: home, PATH: bin, COORD_NODE: join(bin, "node"),
        COORD_ISSUE: "", PNPM_LOG: pnpmLog, COREPACK_LOG: corepackLog, CAPTURE: capture
      }
    });
    expect(launched.status, launched.stderr).toBe(0);
    expect(readFileSync(capture, "utf8")).toBe("--permission-mode\nauto\n");
    expect(existsSync(corepackLog)).toBe(false);
    if (available.pnpm && available.lockfile) {
      expect(readFileSync(pnpmLog, "utf8")).toBe(`${clone}\n--version\n`);
      expect(launched.stdout).toContain("pnpm: 12.15.0");
    } else {
      expect(existsSync(pnpmLog)).toBe(false);
      expect(launched.stdout).not.toContain("pnpm:");
    }
  });

  it("launches Muse unsandboxed with automatic delivery and no self-update", () => {
    const fixture = product("plain");
    const home = join(fixture.workspaceRoot, "home with spaces");
    const completesRoot = join(fixture.workspaceRoot, "completion mailbox");
    const result = installOnce(fixture, { agents: ["muse"], completesRoot, home });
    const clone = result.clones[0] as string;
    for (const directory of [
      join(completesRoot, "issue-17", "muse"),
      join(fixture.coordRoot, "issue-17", "agents", "muse", "responses"),
      join(fixture.coordRoot, "issue-17", "inputs"),
      join(fixture.coordRoot, "issue-17", "worktrees")
    ]) mkdirSync(directory, { recursive: true });
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(bin, "muse"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CAPTURE"\n' +
      'printf \'%s\\n\' "$MUSE_NO_AUTO_UPDATE" "$(command -v git)" "$COORD_ISSUE" > "$CAPTURE.env"\n',
    { mode: 0o755 });
    for (const issue of ["17", ""]) {
      const capture = join(fixture.workspaceRoot, `muse-${issue || "manual"}.args`);
      execFileSync("/bin/bash", [join(clone, "start-muse.sh")], {
        cwd: clone,
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", COORD_NODE: join(bin, "node"), COORD_ISSUE: issue, CAPTURE: capture },
        stdio: "pipe"
      });
      expect(readFileSync(capture, "utf8").trimEnd().split("\n")).toEqual([
        "--approval-mode", "never", "--disable-sandbox", "--trust-workspace"
      ]);
      expect(readFileSync(`${capture}.env`, "utf8")).toBe(`1\n${clone}/.coord/bin/git\n${issue}\n`);
    }
    expect(readConfig(result.configPath).agents).toMatchObject([{
      id: "muse", delivery: "both", harnessProcess: "muse", nudgePrelude: [], nudgeSubmit: ["Enter"], terminalProfile: "Basic"
    }]);
    expect(DEFAULT_CLONE_IGNORES).toContain(".muse/");
    for (const path of [".gitignore", "templates/product/gitignore.coordination.block"]) {
      expect(readFileSync(join(repoRoot, path), "utf8").split("\n")).toContain(".muse/");
    }
    expect(git(clone, "check-ignore", ".muse/hooks.json")).toBe(".muse/hooks.json");
    expect(existsSync(join(clone, ".muse/hooks.json"))).toBe(false);
  });

  /**
   * `--mode accept-edits` is an execution mode, not a permission grant, so on
   * its own it left every out-of-whitelist tool call waiting on an owner
   * prompt — time analytics attributes to agent wait rather than to work. Both
   * flags are needed, and asserting the generated content is what stops the
   * grant being dropped again by a later launcher edit.
   */
  it("launches Antigravity unattended without losing its execution mode", () => {
    const fixture = product();
    const result = installOnce(fixture, { agents: ["antigravity"] });
    const clone = result.clones[0] as string;
    const launcher = readFileSync(join(clone, "start-antigravity.sh"), "utf8");
    expect(launcher).toContain('exec "${coord_agent_cmd[@]}" --mode accept-edits --dangerously-skip-permissions');
    expect(launcher).toContain('export PATH="$HOME/.local/bin:$PATH"');
    // The user-global status line lands in the fixture, never the owner's home.
    expect(existsSync(join(fixture.workspaceRoot, "home", ".gemini", "antigravity-cli", "settings.json"))).toBe(true);
  });
});
