import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { load } from "js-yaml";
import { checkCommandSchema } from "./protocol.js";
import type { CheckCommand, CoordinatorConfig, WorkspaceDeclaration } from "./state.js";
import type { ProjectPolicyProposal } from "./setupWorkspace.js";

const nodeScripts = (productRoot: string): Set<string> => {
  try {
    const parsed = JSON.parse(readFileSync(join(productRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    return new Set<string>();
  }
};

const makeTargets = (productRoot: string): Set<string> => {
  try {
    const content = readFileSync(join(productRoot, "Makefile"), "utf8");
    return new Set([...content.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((match) => match[1] as string));
  } catch {
    return new Set<string>();
  }
};

const hasFlutterSdk = (productRoot: string): boolean => {
  const mapping = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  try {
    const pubspec = mapping(load(readFileSync(join(productRoot, "pubspec.yaml"), "utf8")));
    const dependencies = mapping(pubspec.dependencies);
    const development = mapping(pubspec.dev_dependencies);
    return [dependencies.flutter, development.flutter, development.flutter_test]
      .some((dependency) => mapping(dependency).sdk === "flutter");
  } catch {
    return false;
  }
};

/** Legacy ecosystem proposals omit local timing when they find no command.
 * Guided onboarding makes the explicit timing/empty-list decision separately.
 */
const proposedVerify = (
  precommit: CheckCommand[],
  prepush: CheckCommand[]
): { verify?: { precommit: CheckCommand[]; prepush: CheckCommand[] } } =>
  precommit.length === 0 && prepush.length === 0 ? {} : { verify: { precommit, prepush } };

/**
 * Scaffold a project's declared policy from what its tree obviously is.
 *
 * This is the ONLY place ecosystem detection is allowed, and its output is
 * written into the workspace config for an operator to review. No hook body
 * ever sniffs: a proposal made once and recorded is reviewable, whereas a
 * decision remade silently on every commit is the drift this issue exists to
 * remove.
 */
export const proposeToolchainPolicy = (productRoot: string, excluded: ReadonlySet<string> = new Set()): ProjectPolicyProposal => {
  const has = (relative: string): boolean => existsSync(join(productRoot, relative));

  if (!excluded.has("cargo") && has("Cargo.toml")) {
    return {
      toolchain: "cargo",
      verify: {
        precommit: [{ name: "check", argv: ["cargo", "check", "--all-targets"] }],
        prepush: [{ name: "test", argv: ["cargo", "test"] }]
      },
      checks: [{ name: "test", argv: ["cargo", "test"] }],
      workflowCriticalPrefixes: ["src/", "tests/"],
      workflowCriticalFiles: ["Cargo.toml", "Cargo.lock"]
    };
  }

  if (!excluded.has("go") && has("go.mod")) {
    return {
      toolchain: "go",
      verify: {
        precommit: [{ name: "vet", argv: ["go", "vet", "./..."] }],
        prepush: [{ name: "test", argv: ["go", "test", "./..."] }]
      },
      checks: [
        { name: "build", argv: ["go", "build", "./..."] },
        { name: "test", argv: ["go", "test", "./..."] }
      ],
      workflowCriticalPrefixes: ["cmd/", "internal/", "pkg/"],
      workflowCriticalFiles: ["go.mod", "go.sum"]
    };
  }

  const flutter = hasFlutterSdk(productRoot);
  if (!["npm", "pnpm", "yarn"].some((name) => excluded.has(name)) && has("package.json")) {
    const scripts = nodeScripts(productRoot);
    const manager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const runScript = (name: string): CheckCommand => ({
      name,
      argv: manager === "npm" ? ["npm", "run", "--silent", name] : [manager, "run", name]
    });
    const precommit = ["check:fast", "check", "lint"].filter((name) => scripts.has(name)).slice(0, 1);
    const prepush = ["test:e2e"].filter((name) => scripts.has(name));
    const finalization = ["check", "test"].filter((name) => scripts.has(name)).slice(0, 1);
    const proposal: ProjectPolicyProposal = {
      toolchain: manager,
      ...proposedVerify(precommit.map(runScript), prepush.map(runScript)),
      checks: finalization.length === 0 ? undefined : finalization.map(runScript),
      workflowCriticalPrefixes: ["src/", "test/", "scripts/", "githooks/"],
      workflowCriticalFiles: ["package.json", has("pnpm-lock.yaml") ? "pnpm-lock.yaml" : has("yarn.lock") ? "yarn.lock" : "package-lock.json"]
    };
    // Preserve existing Node gates; only a confirmed Flutter app may fall
    // through an incidental Node manifest with no finalization script.
    if (proposal.checks !== undefined || !flutter) return proposal;
  }

  const targets = makeTargets(productRoot);
  let make: ProjectPolicyProposal | undefined;
  if (!excluded.has("make") && targets.size > 0) {
    const target = (name: string): CheckCommand => ({ name, argv: ["make", name] });
    make = {
      toolchain: "make",
      ...proposedVerify(targets.has("check") ? [target("check")] : [], []),
      checks: targets.has("test") ? [target("test")] : undefined,
      workflowCriticalPrefixes: [],
      workflowCriticalFiles: ["Makefile"]
    };
    // Reinstall must not replace an already usable project test workflow.
    if (make.checks !== undefined) return make;
  }

  if (!excluded.has("flutter") && flutter) {
    const analyze = { name: "analyze", argv: ["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"] };
    const test = { name: "test", argv: ["flutter", "test"] };
    return {
      toolchain: "flutter",
      verify: { precommit: [analyze], prepush: [test] },
      checks: [analyze, test],
      workflowCriticalPrefixes: ["lib/", "test/", "integration_test/", "android/", "ios/", "web/", "macos/", "windows/", "linux/"],
      workflowCriticalFiles: ["pubspec.yaml", "pubspec.lock", "analysis_options.yaml"]
    };
  }

  if (!excluded.has("python") && ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"].some(has)) {
    const test = { name: "test", argv: ["pytest", "-q"] };
    return {
      toolchain: "python",
      verify: { precommit: [test], prepush: [] },
      checks: [test],
      workflowCriticalPrefixes: ["src/", "tests/", "test/"],
      workflowCriticalFiles: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pytest.ini", "tox.ini",
        "uv.lock", "poetry.lock", "Pipfile", "Pipfile.lock"]
    };
  }

  return make ?? { workflowCriticalPrefixes: [], workflowCriticalFiles: [] };
};

export const NO_CHECKS = "Automated checks skipped: none configured.";
export type CheckPlan = { label: string; source: string; commands: CheckCommand[]; unresolved: string[] };
export type CheckDiscovery = { evidence: string[]; plans: CheckPlan[] };
export type CheckSettings = Pick<CoordinatorConfig, "checks" | "verify">;
export type CheckPrompts = {
  choose(question: string, choices: readonly string[]): Promise<string | null>;
  ask(question: string): Promise<string | null>;
  print(text: string): void;
};

const jsonObject = (root: string, path: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    return value as Record<string, unknown>;
  } catch (error) { throw new Error(`Invalid project metadata ${join(root, path)}: ${String(error)}`); }
};

/** Only ordinary files under the project, bounded and sorted; never follows links. */
const projectFiles = (root: string): string[] => {
  const result: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || result.length > 5000) return;
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["node_modules", "build", "dist", "vendor", "Pods"].includes(entry.name)) continue;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isFile()) result.push(path);
      else if (entry.isDirectory()) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return result;
};

type Preset = Record<string, unknown> & { name: string };
const cmakePlans = (root: string): CheckPlan[] => {
  const groups = { configurePresets: new Map<string, Preset>(), buildPresets: new Map<string, Preset>(), testPresets: new Map<string, Preset>() };
  const visited = new Set<string>(), active = new Set<string>();
  const read = (path: string) => {
    if (active.has(path)) throw new Error(`CMake preset include cycle at ${path}; use a project check script.`);
    if (visited.has(path)) return;
    if (path.startsWith("../") || resolve(root, path) === resolve(root) || !resolve(root, path).startsWith(resolve(root) + "/") || lstatSync(join(root, path)).isSymbolicLink()) {
      throw new Error(`CMake preset include must stay inside the project: ${path}`);
    }
    active.add(path);
    const data = jsonObject(root, path);
    for (const include of Array.isArray(data.include) ? data.include : []) {
      if (typeof include !== "string" || include.includes("$")) throw new Error(`Unresolved CMake include in ${path}; enter a project command.`);
      read(relative(root, resolve(root, dirname(path), include)));
    }
    for (const key of Object.keys(groups) as Array<keyof typeof groups>) {
      if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`Invalid ${key} in ${path}`);
      for (const item of (data[key] ?? []) as unknown[]) {
        if (item === null || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") throw new Error(`Invalid preset in ${path}`);
        if (groups[key].has(item.name)) throw new Error(`Duplicate CMake preset ${item.name}`);
        groups[key].set(item.name, item as Preset);
      }
    }
    active.delete(path); visited.add(path);
  };
  read("CMakePresets.json");
  const resolvePreset = (group: Map<string, Preset>, name: string, chain: string[] = []): Preset => {
    if (chain.includes(name)) throw new Error(`CMake preset inheritance cycle: ${name}`);
    const preset = group.get(name);
    if (preset === undefined) throw new Error(`Missing inherited CMake preset ${name}`);
    const parents = typeof preset.inherits === "string" ? [preset.inherits] : preset.inherits ?? [];
    if (!Array.isArray(parents) || parents.some((value) => typeof value !== "string")) throw new Error(`Invalid CMake inheritance: ${name}`);
    let inherited = {};
    for (const parent of [...parents].reverse()) inherited = { ...inherited, ...resolvePreset(group, parent as string, [...chain, name]) };
    // hidden is not inherited by CMake.
    return { ...inherited, ...preset, hidden: preset.hidden ?? false };
  };
  const resolved = (group: Map<string, Preset>) => [...group.keys()].map((name) => resolvePreset(group, name));
  const configs = resolved(groups.configurePresets), builds = resolved(groups.buildPresets), tests = resolved(groups.testPresets);
  const plans: CheckPlan[] = [];
  for (const build of builds.filter((preset) => preset.hidden !== true && preset.condition !== false)) {
    const configure = configs.find((preset) => preset.name === build.configurePreset && preset.hidden !== true && preset.condition !== false);
    if (configure === undefined) continue;
    const related = tests.filter((test) => test.hidden !== true && test.condition !== false && test.configurePreset === configure.name);
    for (const test of related.length === 0 ? [undefined] : related) {
      const unresolved = [configure, build, ...(test ? [test] : [])].filter((preset) => preset.condition !== undefined && preset.condition !== true)
        .map((preset) => `conditional preset ${preset.name}; enter a project command`);
      if (typeof configure.generator === "string" && /Multi-Config|Xcode|Visual Studio/.test(configure.generator) && build.configuration === undefined) unresolved.push("an explicit multi-configuration build preset; enter a project command");
      if (test && build.configuration !== undefined && test.configuration !== build.configuration) unresolved.push("matching build/test configuration; enter a project command");
      const commands = [{ name: "configure", argv: ["cmake", "--preset", configure.name] },
        { name: "build", argv: ["cmake", "--build", "--preset", build.name] }];
      if (test) commands.push({ name: "test", argv: ["ctest", "--preset", test.name, "--output-on-failure", "--no-tests=error"] });
      plans.push({ label: test ? `CMake tests: ${test.name}` : `CMake build: ${build.name}`, source: `CMakePresets.json (${configure.name} → ${build.name}${test ? ` → ${test.name}` : ""})`, commands, unresolved });
    }
  }
  return plans.length ? plans : [{ label: "CMake presets", source: "CMakePresets.json", commands: [], unresolved: ["a complete configure/build preset chain; enter a project command"] }];
};

/** Discovery is file-only: no build tool, project program or GitHub request. */
export const discoverProjectChecks = (root: string): CheckDiscovery => {
  const files = projectFiles(root), plans: CheckPlan[] = [], evidence: string[] = [];
  const add = (plan: CheckPlan) => { plans.push(plan); evidence.push(plan.source); };
  for (const path of files.filter((path) => /^scripts\/(?:check|test)(?:[.-][^/]*)?\.(?:sh|bash|py)$/.test(path))) {
    const header = readFileSync(join(root, path), "utf8").split("\n")[0] ?? "";
    const interpreter = path.endsWith(".py") ? "python3" : /\bbash\b/.test(header) || path.endsWith(".bash") ? "bash" : "sh";
    add({ label: `Use ${interpreter} ${path}`, source: path, commands: [{ name: "check", argv: [interpreter, path] }], unresolved: [] });
  }
  if (files.includes("CMakePresets.json")) for (const plan of cmakePlans(root)) add(plan);
  else if (files.includes("CMakeLists.txt")) add({ label: "CMake project", source: "CMakeLists.txt", commands: [], unresolved: ["configure/build/test commands or a project script"] });
  const containers = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /\.(?:xcworkspace|xcodeproj)$/.test(entry.name)).map((entry) => entry.name).sort();
  for (const container of containers) {
    const workspace = container.endsWith(".xcworkspace");
    const refs = workspace && existsSync(join(root, container, "contents.xcworkspacedata"))
      ? [...readFileSync(join(root, container, "contents.xcworkspacedata"), "utf8").matchAll(/location\s*=\s*"group:([^"<>]+\.xcodeproj)"/g)].map((match) => match[1]!) : [];
    const schemes = files.filter((path) => path.includes("/xcshareddata/xcschemes/") && path.endsWith(".xcscheme") && [container, ...refs].some((prefix) => path.startsWith(prefix + "/")));
    for (const path of schemes) {
      const xml = readFileSync(join(root, path), "utf8"), testAction = /<TestAction\b([\s\S]*?)<\/TestAction>/.exec(xml);
      const hasTests = testAction !== null && (/<TestableReference\b(?![^>]*skipped\s*=\s*"YES")/.test(testAction[1]!) || /<TestPlanReference\b/.test(testAction[1]!));
      const action = hasTests ? testAction?.[1] : /<LaunchAction\b([^>]*)>/.exec(xml)?.[1];
      const configuration = /buildConfiguration\s*=\s*"([^"<>]+)"/.exec(action ?? "")?.[1];
      const scheme = path.slice(path.lastIndexOf("/") + 1, -9);
      add({ label: `Xcode ${hasTests ? "tests" : "build"}: ${scheme}`, source: `${path} (${container})`,
        commands: [{ name: hasTests ? "test" : "build", argv: ["xcodebuild", workspace ? "-workspace" : "-project", container, "-scheme", scheme,
          "-configuration", configuration ?? "{configuration}", "-destination", "{destination}", hasTests ? "test" : "build"] }],
        unresolved: [...(configuration === undefined ? ["configuration"] : []), "destination"] });
    }
    if (!schemes.length) add({ label: `Xcode ${container}`, source: container, commands: [], unresolved: ["a shared scheme; enter a project command"] });
  }
  if (files.includes("Package.swift")) {
    const manifest = readFileSync(join(root, "Package.swift"), "utf8");
    const commands = [{ name: "build", argv: ["swift", "build"] }];
    if (/\.testTarget\s*\(/.test(manifest)) commands.push({ name: "test", argv: ["swift", "test"] });
    add({ label: commands.length > 1 ? "Swift package tests" : "Swift package build", source: "Package.swift", commands, unresolved: [] });
  }
  if (files.includes("package.json")) jsonObject(root, "package.json");
  if (files.includes("pubspec.yaml")) {
    try { load(readFileSync(join(root, "pubspec.yaml"), "utf8")); }
    catch (error) { throw new Error(`Invalid pubspec.yaml: ${String(error)}`); }
  }
  const excluded = new Set<string>();
  for (;;) {
    const policy = proposeToolchainPolicy(root, excluded);
    if (!policy.toolchain || excluded.has(policy.toolchain)) break;
    excluded.add(policy.toolchain);
    const source = ({ cargo: "Cargo.toml", go: "go.mod", make: "Makefile", flutter: "pubspec.yaml", python: "Python package metadata" } as Record<string, string>)[policy.toolchain] ?? "package.json";
    if (policy.toolchain === "python" && !files.some((path) => /(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.py$|^(pytest.ini|tox.ini)$/.test(path)) &&
      !(files.includes("pyproject.toml") && /\[tool\.pytest/.test(readFileSync(join(root, "pyproject.toml"), "utf8")))) {
      evidence.push(`${source} (language context; no recognized test entry point)`);
      continue;
    }
    if (policy.toolchain === "flutter" && !files.some((path) => /^test\/.*_test\.dart$/.test(path))) policy.checks = policy.checks?.filter((command) => command.name !== "test");
    if (policy.checks?.length) add({ label: `${policy.toolchain} checks`, source, commands: policy.checks, unresolved: [] });
    else if (source === "package.json" && nodeScripts(root).has("build")) add({ label: `${policy.toolchain} build`, source,
      commands: [{ name: "build", argv: [policy.toolchain, "run", "build"] }], unresolved: [] });
    else if (policy.toolchain === "make" && makeTargets(root).has("check")) add({ label: "Make checks", source,
      commands: [{ name: "check", argv: ["make", "check"] }], unresolved: [] });
    else if (policy.toolchain === "make" && makeTargets(root).has("all")) add({ label: "Make build", source,
      commands: [{ name: "build", argv: ["make", "all"] }], unresolved: [] });
  }
  evidence.push(...files.filter((path) => /^(?:test|tests|Tests)\//.test(path)).slice(0, 12).map((path) => `${path} (test source/context)`));
  return { evidence: [...new Set(evidence)], plans };
};

/** Tokenization only: no shell expansion, substitution or evaluation. */
export const parseCheckCommand = (text: string): string[] => {
  const args: string[] = []; let token = "", quote = "", escaped = false, started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (escaped) { token += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") {
      // In double quotes a backslash before an ordinary character is literal.
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(text[index + 1] ?? "")) token += char;
      else if (text[index + 1] === "\n") index++;
      else escaped = true;
      started = true;
      continue;
    }
    if (quote) { if (char === quote) quote = ""; else token += char; started = true; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/[|&;<>$`]/.test(char)) throw new Error("Use a project script for shell operators, or explicitly enter a shell command.");
    if (/\s/.test(char)) { if (started) args.push(token); token = ""; started = false; }
    else { token += char; started = true; }
  }
  if (escaped || quote) throw new Error("Unclosed quote or escape in command.");
  if (started) args.push(token);
  if (!args[0]?.trim()) throw new Error("Enter an executable and its arguments.");
  return args;
};

export const settingsForChecks = (commands: CheckCommand[], timing: string): CheckSettings => ({
  verify: { precommit: timing === "Before each agent commit" || timing === "Both" ? commands : [], prepush: [] },
  checks: timing === "Before opening a pull request" || timing === "Both" ? commands : []
});

export const chooseProjectChecks = async (root: string, declared: WorkspaceDeclaration | null, saved: CoordinatorConfig | null,
  prompts?: CheckPrompts): Promise<CheckSettings & { changed: boolean }> => {
  if (declared?.checks !== undefined && !saved) return { verify: declared.verify ?? { precommit: [], prepush: [] }, checks: declared.checks, changed: false };
  if (declared?.verify !== undefined && declared.checks !== undefined) return { verify: declared.verify, checks: declared.checks, changed: false };
  if (saved && (declared?.verify !== undefined || declared?.checks !== undefined)) {
    return { verify: declared.verify ?? saved.verify, checks: declared.checks ?? saved.checks, changed: false };
  }
  if (saved && !prompts) return { verify: saved.verify, checks: saved.checks, changed: false };
  if (saved && prompts) {
    prompts.print(`Saved build and test commands:\n${JSON.stringify({ verify: saved.verify, checks: saved.checks, verification: saved.verification, documentation: saved.documentation, acceptedAdditions: saved.adoptedChecks?.map((entry) => ({ description: entry.proposal.description, commands: entry.proposal.commands, entryPoints: entry.proposal.entryPointPaths })) }, null, 2)}\n`);
    prompts.print("Changing settings replaces these commands and accepted additions, and resets coordinator and documentation check overrides; keeping them preserves their timing and activation rules.\n");
    const choice = await prompts.choose("Keep or change these settings?", ["Keep these settings", "Change settings"]);
    if (choice === null) throw new Error("Onboarding cancelled; settings were not changed.");
    if (choice === "Keep these settings") return { verify: saved.verify, checks: saved.checks, changed: false };
  }
  const discovery = discoverProjectChecks(root);
  let commands: CheckCommand[] = [];
  let timing = "Before opening a pull request";
  if (!prompts) {
    if (discovery.plans.length > 1 || discovery.plans.some((plan) => plan.unresolved.length)) {
      throw new Error(`Choose build and test commands in a terminal or use --declare <file.json>: ${discovery.plans.map((plan) => `${plan.label} (${plan.source}; ${plan.unresolved.join(", ")})`).join("; ")}. Example: { "verify": { "precommit": [], "prepush": [] }, "checks": [{ "name": "check", "argv": ["sh", "scripts/check.sh"] }] }`);
    }
    commands = discovery.plans[0]?.commands ?? [];
  } else {
    prompts.print(`Found:\n${discovery.evidence.map((entry) => `  ${entry}`).join("\n") || "  No recognized build or test command."}\n`);
    const labels = discovery.plans.map((plan) => `${plan.label} — ${plan.source}`);
    const custom = "Enter another build or test command", none = "Continue without automated checks for now";
    const choice = await prompts.choose("How do you check that changes to this project are ready?", [...labels, custom, none]);
    if (choice === null) throw new Error("Onboarding cancelled; settings were not changed.");
    if (choice === custom) {
      for (;;) {
        const line = await prompts.ask("Build or test command (blank finishes the ordered list):");
        if (line === null) throw new Error("Onboarding cancelled; settings were not changed.");
        if (!line.trim()) break;
        commands.push({ name: `check-${commands.length + 1}`, argv: parseCheckCommand(line) });
      }
      if (!commands.length) throw new Error("No command entered; choose no automated checks explicitly.");
    } else if (choice !== none) {
      const plan = discovery.plans[labels.indexOf(choice)];
      if (!plan) throw new Error("Unknown check selection.");
      commands = plan.commands.map((command) => ({ ...command, argv: [...command.argv] }));
      for (const parameter of plan.unresolved) {
        if (!["configuration", "destination"].includes(parameter)) throw new Error(`Resolve ${parameter}.`);
        const value = await prompts.ask(`Enter Xcode ${parameter}:`);
        if (!value?.trim()) throw new Error(`A ${parameter} is required; settings were not changed.`);
        commands = commands.map((command) => ({ ...command, argv: command.argv.map((arg) => arg === `{${parameter}}` ? value : arg) }));
      }
    }
    if (commands.length) {
      const selected = await prompts.choose("When should these commands run?", ["Before opening a pull request", "Before each agent commit", "Both"]);
      if (selected === null) throw new Error("Onboarding cancelled; settings were not changed.");
      timing = selected;
    }
  }
  commands.forEach((command) => checkCommandSchema.parse(command));
  const settings = settingsForChecks(commands, timing);
  const result = { verify: declared?.verify ?? settings.verify, checks: declared?.checks ?? settings.checks, changed: saved !== null };
  prompts?.print(commands.length ? `Commands and timing (${timing}):\n${JSON.stringify(result, null, 2)}\n` : `${NO_CHECKS}\n`);
  return result;
};

/** Synchronous resolution for install and other noninteractive callers. */
export const resolveProjectChecks = (root: string, declared: WorkspaceDeclaration | null, saved: CoordinatorConfig | null): CheckSettings => {
  const checks = declared?.checks ?? saved?.checks, verify = declared?.verify ?? saved?.verify;
  if (checks !== undefined) return { checks, verify: saved ? verify : verify ?? { precommit: [], prepush: [] } };
  const discovery = discoverProjectChecks(root);
  if (discovery.plans.length > 1 || discovery.plans.some((plan) => plan.unresolved.length)) {
    throw new Error(`Ambiguous build and test commands: ${discovery.plans.map((plan) => `${plan.label}: ${plan.source} ${plan.unresolved.join(", ")}`).join("; ")}. Run coord onboard in a terminal or pass --declare <file.json>, for example { "verify": { "precommit": [], "prepush": [] }, "checks": [] }.`);
  }
  return { checks: checks ?? discovery.plans[0]?.commands ?? [], verify: verify ?? { precommit: [], prepush: [] } };
};
