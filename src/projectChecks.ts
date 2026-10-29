import { existsSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { load } from "js-yaml";
import { git } from "./gitExec.js";
import type { CheckCommand, CoordinatorConfig, VerifyConfig } from "./state.js";

/**
 * Read-only project check discovery and command input for onboarding (#261).
 *
 * Discovery reads tracked files only: it never runs project code, a build
 * system, CI configuration or GitHub. Every suggestion names the file that
 * justifies it, test files are context rather than selections, and anything
 * the tree cannot decide (an Xcode destination, competing preset chains) is
 * returned as an unresolved choice for the owner instead of being guessed.
 */

// ------------------------------------------------------------ ecosystems --

export type ProjectPolicyProposal = {
  toolchain?: string;
  verify?: { precommit: CheckCommand[]; prepush: CheckCommand[] };
  checks?: CheckCommand[];
  documentation?: CoordinatorConfig["documentation"];
  workflowCriticalPrefixes: string[];
  workflowCriticalFiles: string[];
};

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

/**
 * A proposal only carries `verify` when it actually found something to run.
 *
 * Emitting `{ precommit: [], prepush: [] }` because nothing was recognised
 * writes the operator's explicit opt-out on their behalf: the hooks then read a
 * deliberate "this project has no local checks" and allow every commit. Missing
 * must stay missing so the hooks fail closed and say what to declare.
 */
const proposedVerify = (
  precommit: CheckCommand[],
  prepush: CheckCommand[]
): { verify?: { precommit: CheckCommand[]; prepush: CheckCommand[] } } =>
  precommit.length === 0 && prepush.length === 0 ? {} : { verify: { precommit, prepush } };

/**
 * Scaffold a project's declared policy from what its tree obviously is.
 *
 * Ecosystem detection lives only in this module, and its output is written
 * into the workspace config for an operator to review. No hook body
 * ever sniffs: a proposal made once and recorded is reviewable, whereas a
 * decision remade silently on every commit is the drift this issue exists to
 * remove.
 */
export const proposeToolchainPolicy = (productRoot: string): ProjectPolicyProposal => {
  const has = (relative: string): boolean => existsSync(join(productRoot, relative));

  if (has("Cargo.toml")) {
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

  if (has("go.mod")) {
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
  if (has("package.json")) {
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
  if (targets.size > 0) {
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

  if (flutter) {
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

  if (["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"].some(has)) {
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


// -------------------------------------------------------------- settings --

/** Commit and pull-request lists exactly as the workspace config stores them. */
export type CheckSettings = { verify?: VerifyConfig; checks: CheckCommand[] };
export type CheckTiming = "commit" | "pull-request" | "both";

export const NO_CHECKS_MESSAGE = "Automated checks skipped: none configured.";

export const TIMING_LABELS: Readonly<Record<CheckTiming, string>> = {
  commit: "Before each agent commit",
  "pull-request": "Before opening a pull request with the completed changes",
  both: "Both"
};

export const emptyCheckSettings = (): CheckSettings => ({ verify: { precommit: [], prepush: [] }, checks: [] });

/** Selected commands map directly to the commit hook list and the pre-PR list. */
export const settingsForTiming = (commands: readonly CheckCommand[], timing: CheckTiming): CheckSettings => ({
  verify: { precommit: timing === "pull-request" ? [] : [...commands], prepush: [] },
  checks: timing === "commit" ? [] : [...commands]
});

const SAFE_ARGUMENT = /^[A-Za-z0-9_./=:,+@%^-]+$/;

/** Render an argument vector so arguments containing spaces stay visibly whole. */
export const displayCommand = (argv: readonly string[]): string =>
  argv.map((argument) => SAFE_ARGUMENT.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`).join(" ");

export const describeSequence = (commands: readonly CheckCommand[]): string =>
  commands.map((command) => displayCommand(command.argv)).join(" → ");

export const isEmptyCheckSettings = (settings: CheckSettings): boolean =>
  settings.verify !== undefined && settings.verify.precommit.length === 0 && settings.verify.prepush.length === 0 &&
  settings.checks.length === 0;

/** Plain-language commands and timing, shown before saving and when re-onboarding. */
export const describeCheckSettings = (settings: CheckSettings): string[] => {
  if (isEmptyCheckSettings(settings)) return [NO_CHECKS_MESSAGE];
  const lines = [
    `Before each agent commit: ${settings.verify === undefined
      ? "not configured (agent commits stay blocked until this is chosen)"
      : settings.verify.precommit.length === 0 ? "none" : describeSequence(settings.verify.precommit)}`
  ];
  if ((settings.verify?.prepush.length ?? 0) > 0) lines.push(`Before each agent push: ${describeSequence(settings.verify!.prepush)}`);
  lines.push(`Before opening a pull request: ${settings.checks.length === 0 ? "none" : describeSequence(settings.checks)}`);
  return lines;
};

/**
 * One owner-facing outcome line. An empty list is a skip, never a pass, and a
 * selection of only configure/build steps is a build result, not a test result.
 */
export const describeCheckOutcome = (
  commands: readonly Pick<CheckCommand, "name">[],
  results?: readonly { name: string; exitCode: number }[]
): string => {
  if (commands.length === 0) return NO_CHECKS_MESSAGE;
  const buildOnly = commands.every((command) => command.name === "configure" || command.name === "build");
  const failed = results?.find((result) => result.exitCode !== 0);
  const status = results === undefined ? "not run"
    : failed !== undefined ? `failed at ${failed.name}`
      : results.length < commands.length ? "incomplete" : "passed";
  return `${buildOnly ? "Build result" : "Build and test result"}: ${status} (${commands.map((command) => command.name).join(", ")}).`;
};

// ---------------------------------------------------------- command input --

const SHELL_OPERATORS = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`"]);

/**
 * Split one typed command into an argument vector without a shell: single and
 * double quotes and backslash escapes are honoured, nothing is expanded, and
 * empty quoted arguments survive. Unquoted shell operators are refused so a
 * pipeline is never silently passed to a program as literal arguments.
 */
export const parseCommandLine = (text: string): string[] => {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quote === "'") {
      if (char === "'") quote = null; else current += char;
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") quote = null;
      else if (char === "\\" && index + 1 < text.length && "\"\\$`".includes(text[index + 1] as string)) current += text[++index];
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; started = true; continue; }
    if (char === "\\") {
      if (index + 1 >= text.length) throw new Error("A command cannot end with a backslash.");
      current += text[++index];
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    if (SHELL_OPERATORS.has(char)) {
      throw new Error(`Commands run without a shell, so '${char}' is not supported. ` +
        "Put pipelines, redirection or variables in a checked-in script and enter that script, " +
        "or quote the character if it is a literal argument.");
    }
    current += char;
    started = true;
  }
  if (quote !== null) throw new Error(`Unmatched ${quote === "'" ? "single" : "double"} quote.`);
  if (started) argv.push(current);
  if (argv.length === 0) throw new Error("Enter a command.");
  return argv;
};

// -------------------------------------------------------------- discovery --

export type CheckEvidence = { path: string; label: string };
/** A parameter the tree cannot decide; its placeholder appears verbatim in argv. */
export type UnresolvedChoice = { placeholder: string; question: string };
export type CheckPlan = {
  source: string;
  detail: string;
  kind: "build" | "test";
  commands: CheckCommand[];
  unresolved: UnresolvedChoice[];
  /** Established ecosystem plans keep their own commit/pull-request split. */
  settings?: CheckSettings;
};
export type CheckDiscovery = { evidence: CheckEvidence[]; plans: CheckPlan[]; problems: string[] };

type TrackedEntry = { mode: string; path: string };

const trackedEntries = (productRoot: string): TrackedEntry[] => {
  const listed = git(productRoot, "ls-files", "--stage", "-z");
  if (listed.exitCode !== 0) return [];
  return listed.stdout.split("\0").flatMap((entry) => {
    const match = /^(\d{6}) [a-f0-9]+ 0\t([\s\S]+)$/.exec(entry);
    return match === null ? [] : [{ mode: match[1] as string, path: match[2] as string }];
  });
};

const readTracked = (productRoot: string, path: string): string | null => {
  try {
    return readFileSync(join(productRoot, path), "utf8");
  } catch {
    return null;
  }
};

/** Interpreter named by a script's shebang, so a bash script is not run by plain sh. */
const scriptArgv = (productRoot: string, entry: TrackedEntry): string[] => {
  if (entry.mode === "100755") return [`./${entry.path}`];
  const shebang = /^#!\S*?(?:\/env\s+)?\S*?\b(bash|zsh|sh)\b/.exec(readTracked(productRoot, entry.path)?.split("\n")[0] ?? "");
  return [shebang?.[1] ?? "sh", entry.path];
};

const SCRIPT_PATHS = ["scripts/check.sh", "scripts/test.sh", "check.sh", "test.sh"];

const discoverScripts = (productRoot: string, tracked: readonly TrackedEntry[]): CheckDiscovery => {
  const plans: CheckPlan[] = [];
  const evidence: CheckEvidence[] = [];
  for (const path of SCRIPT_PATHS) {
    const entry = tracked.find((candidate) => candidate.path === path && (candidate.mode === "100644" || candidate.mode === "100755"));
    if (entry === undefined) continue;
    const name = basename(path, ".sh");
    evidence.push({ path, label: name === "check" ? "Project check script" : "Project test script" });
    plans.push({ source: path, detail: "project script", kind: "test", unresolved: [],
      commands: [{ name, argv: scriptArgv(productRoot, entry) }] });
  }
  return { evidence, plans, problems: [] };
};

const MANIFESTS: Readonly<Record<string, readonly string[]>> = {
  npm: ["package.json"], pnpm: ["package.json"], yarn: ["package.json"], cargo: ["Cargo.toml"], go: ["go.mod"],
  make: ["Makefile"], flutter: ["pubspec.yaml"],
  python: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"]
};

const discoverEcosystem = (productRoot: string): CheckDiscovery => {
  const proposal = proposeToolchainPolicy(productRoot);
  if (proposal.checks === undefined || proposal.checks.length === 0) return { evidence: [], plans: [], problems: [] };
  const source = (MANIFESTS[proposal.toolchain ?? ""] ?? []).find((path) => existsSync(join(productRoot, path))) ??
    proposal.toolchain ?? "project metadata";
  const settings: CheckSettings = { verify: proposal.verify ?? { precommit: [], prepush: [] }, checks: proposal.checks };
  return {
    evidence: [{ path: source, label: `${proposal.toolchain ?? "Project"} build and test commands` }],
    plans: [{ source, detail: `${proposal.toolchain ?? "project"} commands`, kind: "test", unresolved: [],
      commands: proposal.checks, settings }],
    problems: []
  };
};

type Preset = { name: string; file: string; body: Record<string, unknown> };
type PresetKind = "configurePresets" | "buildPresets" | "testPresets";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Checked-in CMake presets, following tracked local includes with cycle and path guards. */
const loadPresets = (productRoot: string, tracked: ReadonlySet<string>): {
  presets: Record<PresetKind, Map<string, Preset>>; files: string[]; problems: string[];
} => {
  const presets: Record<PresetKind, Map<string, Preset>> = {
    configurePresets: new Map(), buildPresets: new Map(), testPresets: new Map()
  };
  const problems: string[] = [];
  const files: string[] = [];
  const queue = tracked.has("CMakePresets.json") ? ["CMakePresets.json"] : [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readTracked(productRoot, file) ?? "");
    } catch (error) {
      problems.push(`${file}: cannot be parsed as JSON (${error instanceof Error ? error.message : String(error)}).`);
      continue;
    }
    if (!isRecord(parsed)) { problems.push(`${file}: expected a JSON object.`); continue; }
    files.push(file);
    for (const include of Array.isArray(parsed.include) ? parsed.include : []) {
      const target = typeof include === "string" ? posix.normalize(posix.join(posix.dirname(file), include)) : "";
      if (target === "" || target.startsWith("../") || posix.isAbsolute(target) || !tracked.has(target)) {
        problems.push(`${file}: include ${JSON.stringify(include)} is not a tracked repository file, so its presets are not offered.`);
      } else queue.push(target);
    }
    for (const kind of ["configurePresets", "buildPresets", "testPresets"] as const) {
      for (const body of Array.isArray(parsed[kind]) ? parsed[kind] : []) {
        if (!isRecord(body) || typeof body.name !== "string") continue;
        if (presets[kind].has(body.name)) problems.push(`${file}: duplicate ${kind} name ${body.name}.`);
        else presets[kind].set(body.name, { name: body.name, file, body });
      }
    }
  }
  return { presets, files, problems };
};

/** A preset field, inherited through `inherits` in declaration order, with a cycle guard. */
const presetField = (map: Map<string, Preset>, name: string, field: string, seen = new Set<string>()): unknown => {
  const preset = map.get(name);
  if (preset === undefined || seen.has(name)) return undefined;
  seen.add(name);
  if (preset.body[field] !== undefined) return preset.body[field];
  const parents = typeof preset.body.inherits === "string" ? [preset.body.inherits]
    : Array.isArray(preset.body.inherits) ? preset.body.inherits.filter((value): value is string => typeof value === "string") : [];
  for (const parent of parents) {
    const value = presetField(map, parent, field, seen);
    if (value !== undefined) return value;
  }
  return undefined;
};

const discoverCMake = (productRoot: string, tracked: ReadonlySet<string>): CheckDiscovery => {
  const { presets, files, problems } = loadPresets(productRoot, tracked);
  const evidence: CheckEvidence[] = [];
  const plans: CheckPlan[] = [];
  if (files.length === 0) {
    if (tracked.has("CMakeLists.txt")) {
      evidence.push({ path: "CMakeLists.txt", label: "CMake project without presets (enter commands, or add CMakePresets.json)" });
    }
    return { evidence, plans, problems };
  }
  /** Hidden presets are templates; conditions and macros in them are not evaluated here. */
  const usable = (kind: PresetKind, name: string): boolean => {
    const preset = presets[kind].get(name);
    if (preset === undefined || preset.body.hidden === true) return false;
    if (presetField(presets[kind], name, "condition") !== undefined) {
      problems.push(`${preset.file}: preset ${name} has a condition coord does not evaluate, so it is not offered automatically.`);
      return false;
    }
    return true;
  };
  const configureOf = (kind: PresetKind, name: string): string | null => {
    const value = presetField(presets[kind], name, "configurePreset");
    return typeof value === "string" && usable("configurePresets", value) ? value : null;
  };
  const builds = [...presets.buildPresets.keys()].filter((name) => usable("buildPresets", name));
  const tests = [...presets.testPresets.keys()].filter((name) => usable("testPresets", name));
  const configure = (name: string): CheckCommand => ({ name: "configure", argv: ["cmake", "--preset", name] });
  const build = (name: string): CheckCommand => ({ name: "build", argv: ["cmake", "--build", "--preset", name] });
  const tested = new Set<string>();
  for (const test of tests) {
    const configurePreset = configureOf("testPresets", test);
    if (configurePreset === null) {
      problems.push(`${presets.testPresets.get(test)!.file}: test preset ${test} has no usable configure preset.`);
      continue;
    }
    const matching = builds.filter((name) => configureOf("buildPresets", name) === configurePreset);
    if (matching.length === 0) problems.push(`${presets.testPresets.get(test)!.file}: test preset ${test} has no build preset for ${configurePreset}.`);
    for (const buildPreset of matching) {
      tested.add(configurePreset);
      plans.push({ source: presets.testPresets.get(test)!.file, kind: "test", unresolved: [],
        detail: `CMake presets ${configurePreset} / ${buildPreset} / ${test}`,
        commands: [configure(configurePreset), build(buildPreset),
          { name: "test", argv: ["ctest", "--preset", test, "--output-on-failure", "--no-tests=error"] }] });
    }
  }
  for (const buildPreset of builds) {
    const configurePreset = configureOf("buildPresets", buildPreset);
    if (configurePreset === null || tested.has(configurePreset)) continue;
    plans.push({ source: presets.buildPresets.get(buildPreset)!.file, kind: "build", unresolved: [],
      detail: `CMake presets ${configurePreset} / ${buildPreset} (build only, no test preset)`,
      commands: [configure(configurePreset), build(buildPreset)] });
  }
  evidence.push({ path: files[0] as string, label: tests.length > 0 ? "Build and test presets" : "Build presets" });
  return { evidence, plans, problems };
};

const DESTINATION: UnresolvedChoice = {
  placeholder: "<destination>",
  question: "Which xcodebuild destination should the checks use (for example platform=macOS)?"
};
const CONFIGURATION: UnresolvedChoice = {
  placeholder: "<configuration>",
  question: "Which build configuration should the checks use (for example Debug)?"
};

/** Shared schemes with test entries become `xcodebuild test`; others are build choices. */
const discoverXcode = (productRoot: string, paths: readonly string[]): CheckDiscovery => {
  const containers = new Set<string>();
  for (const path of paths) {
    const match = /^((?:[^/]+\/)*?[^/]+\.(?:xcworkspace|xcodeproj))\//.exec(path);
    if (match !== null && !/\.xcodeproj\/project\.xcworkspace$/.test(match[1] as string)) containers.add(match[1] as string);
  }
  if (containers.size === 0) return { evidence: [], plans: [], problems: [] };
  const workspaces = [...containers].filter((path) => path.endsWith(".xcworkspace")).sort();
  const chosen = workspaces.length > 0 ? workspaces : [...containers].sort();
  const evidence: CheckEvidence[] = chosen.map((path) => ({
    path, label: path.endsWith(".xcworkspace") ? "Xcode workspace" : "Xcode project"
  }));
  const plans: CheckPlan[] = [];
  const schemes = new Map<string, string>();
  for (const path of paths) {
    const match = /xcshareddata\/xcschemes\/([^/]+)\.xcscheme$/.exec(path);
    if (match !== null && !schemes.has(match[1] as string)) schemes.set(match[1] as string, path);
  }
  if (schemes.size === 0) {
    evidence.push({ path: chosen[0] as string, label: "No shared schemes (share a scheme in Xcode, or enter a command)" });
  }
  for (const [scheme, path] of [...schemes].sort(([left], [right]) => left.localeCompare(right))) {
    const xml = readTracked(productRoot, path) ?? "";
    const hasTests = /<TestableReference\b/.test(xml) || /<TestPlanReference\b/.test(xml);
    const action = hasTests ? "TestAction" : "LaunchAction";
    const configuration = new RegExp(`<${action}\\b[^>]*\\bbuildConfiguration\\s*=\\s*"([^"]+)"`).exec(xml)?.[1];
    if (!hasTests && !/<BuildActionEntry\b/.test(xml)) continue;
    evidence.push({ path, label: hasTests ? "Shared Xcode scheme with tests" : "Shared Xcode scheme (no tests)" });
    for (const container of chosen) {
      plans.push({
        source: path, kind: hasTests ? "test" : "build",
        detail: `Xcode scheme ${scheme} in ${container}${hasTests ? "" : " (build only)"}`,
        unresolved: configuration === undefined ? [CONFIGURATION, DESTINATION] : [DESTINATION],
        commands: [{ name: hasTests ? "test" : "build", argv: [
          "xcodebuild", hasTests ? "test" : "build", container.endsWith(".xcworkspace") ? "-workspace" : "-project", container,
          "-scheme", scheme, "-configuration", configuration ?? CONFIGURATION.placeholder, "-destination", DESTINATION.placeholder
        ] }]
      });
    }
  }
  return { evidence, plans, problems: [] };
};

/** Package test targets are recognized from the Tests directory, never by evaluating the manifest. */
const discoverSwiftPackage = (tracked: ReadonlySet<string>, paths: readonly string[]): CheckDiscovery => {
  if (!tracked.has("Package.swift")) return { evidence: [], plans: [], problems: [] };
  const hasTests = paths.some((path) => path.startsWith("Tests/"));
  return {
    evidence: [{ path: "Package.swift", label: hasTests ? "Swift package with test targets" : "Swift package (no Tests directory)" }],
    plans: [{ source: "Package.swift", detail: hasTests ? "Swift package build and tests" : "Swift package build only",
      kind: hasTests ? "test" : "build", unresolved: [],
      commands: hasTests ? [{ name: "build", argv: ["swift", "build"] }, { name: "test", argv: ["swift", "test"] }]
        : [{ name: "build", argv: ["swift", "build"] }] }],
    problems: []
  };
};

const LANGUAGES: Readonly<Record<string, string>> = {
  ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".c": "C", ".mm": "Objective-C++", ".m": "Objective-C",
  ".swift": "Swift", ".py": "Python", ".ts": "TypeScript", ".js": "JavaScript", ".go": "Go", ".rs": "Rust",
  ".dart": "Dart", ".sh": "Shell"
};

/** Test directories are context for the owner, not runnable selections. */
const discoverTestContext = (paths: readonly string[]): CheckEvidence[] =>
  ["test", "tests", "Tests"].flatMap((directory) => {
    const files = paths.filter((path) => path.startsWith(`${directory}/`)).sort();
    const first = files[0];
    if (first === undefined) return [];
    const language = LANGUAGES[posix.extname(first).toLowerCase()];
    return [{ path: first, label: `${language === undefined ? "Test file" : `${language} test source`}` +
      (files.length > 1 ? ` (+${files.length - 1} more in ${directory}/)` : "") }];
  });

export const discoverProjectChecks = (productRoot: string): CheckDiscovery => {
  const entries = trackedEntries(productRoot);
  const paths = entries.map((entry) => entry.path);
  const tracked = new Set(paths);
  const parts = [
    discoverScripts(productRoot, entries),
    discoverEcosystem(productRoot),
    discoverCMake(productRoot, tracked),
    discoverXcode(productRoot, paths),
    discoverSwiftPackage(tracked, paths)
  ];
  const scripts = parts[0] as CheckDiscovery;
  const workflows = paths.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)).sort()
    .map((path) => ({ path, label: "CI workflow (context only; not run locally)" }));
  return {
    evidence: [...scripts.evidence, ...discoverTestContext(paths), ...parts.slice(1).flatMap((part) => part.evidence), ...workflows],
    plans: parts.flatMap((part) => part.plans),
    problems: parts.flatMap((part) => part.problems)
  };
};

export const resolvePlanCommands = (plan: CheckPlan, answers: ReadonlyMap<string, string>): CheckCommand[] =>
  plan.commands.map((command) => ({ ...command, argv: command.argv.map((argument) => answers.get(argument) ?? argument) }));

/** Menu text for one plan: the exact commands, then the file behind them. */
export const planLabel = (plan: CheckPlan): string => plan.settings !== undefined
  ? `Use ${describeCheckSettings(plan.settings).join("; ")} (${plan.source})`
  : `Use ${describeSequence(plan.commands)} (${plan.detail}; ${plan.source})`;

export const renderDiscovery = (discovery: CheckDiscovery): string => {
  const width = Math.min(48, Math.max(0, ...discovery.evidence.map((entry) => entry.path.length)) + 3);
  const lines = ["How do you check that changes to this project are ready?", ""];
  if (discovery.evidence.length === 0) lines.push("Found: no build or test metadata.");
  else lines.push("Found:", ...discovery.evidence.map((entry) => `  ${entry.path.padEnd(width)}${entry.label}`));
  if (discovery.problems.length > 0) lines.push("", "Not offered automatically:", ...discovery.problems.map((problem) => `  ${problem}`));
  return `${lines.join("\n")}\n`;
};

// --------------------------------------------------------------- choosing --

export type CheckPrompts = {
  choose(question: string, choices: readonly string[]): Promise<string | null>;
  ask(question: string): Promise<string | null>;
  print(text: string): void;
};

export const KEEP_SETTINGS = "Keep these settings";
export const CHANGE_SETTINGS = "Change them";
export const ENTER_COMMAND = "Enter another build or test command";
export const NO_CHECKS = "Continue without automated checks for now";

export type CheckSelection = { kind: "keep" } | { kind: "change"; settings: CheckSettings; description: string };

const askCommands = async (prompts: CheckPrompts): Promise<CheckCommand[] | null> => {
  const commands: CheckCommand[] = [];
  for (;;) {
    const answer = await prompts.ask(commands.length === 0
      ? "Enter a build or test command (quote arguments containing spaces):"
      : `Command ${commands.length + 1}, run after the previous one (blank line to finish):`);
    if (answer === null) return null;
    if (answer.trim() === "") {
      if (commands.length > 0) return commands;
      prompts.print("Enter at least one command, or choose to continue without automated checks.\n");
      continue;
    }
    try {
      commands.push({ name: `command-${commands.length + 1}`, argv: parseCommandLine(answer) });
    } catch (error) {
      prompts.print(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
};

/**
 * The terminal flow. Returns null when the owner cancels (EOF or an invalid
 * menu answer), so the caller can leave saved settings untouched. Nothing
 * selected here is executed.
 */
export const promptCheckSettings = async (input: {
  discovery: CheckDiscovery;
  saved: CheckSettings | null;
  prompts: CheckPrompts;
}): Promise<CheckSelection | null> => {
  const { prompts, discovery } = input;
  if (input.saved !== null) {
    prompts.print(["Saved build and test commands:", ...describeCheckSettings(input.saved).map((line) => `  ${line}`), ""].join("\n") + "\n");
    const keep = await prompts.choose("Keep or change these settings?", [KEEP_SETTINGS, CHANGE_SETTINGS]);
    if (keep === null) return null;
    if (keep === KEEP_SETTINGS) return { kind: "keep" };
  }
  prompts.print(renderDiscovery(discovery));
  const labels = discovery.plans.map(planLabel);
  const choice = await prompts.choose("Choose how to check changes:", [...labels, ENTER_COMMAND, NO_CHECKS]);
  if (choice === null) return null;
  if (choice === NO_CHECKS) return { kind: "change", settings: emptyCheckSettings(), description: "no automated checks" };
  let commands: CheckCommand[];
  let description: string;
  const plan = discovery.plans[labels.indexOf(choice)];
  if (plan !== undefined) {
    if (plan.settings !== undefined) return { kind: "change", settings: plan.settings, description: `${plan.detail} (${plan.source})` };
    const answers = new Map<string, string>();
    for (const unresolved of plan.unresolved) {
      const answer = await prompts.ask(unresolved.question);
      if (answer === null || answer.trim() === "") return null;
      answers.set(unresolved.placeholder, answer.trim());
    }
    commands = resolvePlanCommands(plan, answers);
    description = `${plan.detail} (${plan.source})`;
  } else {
    const typed = await askCommands(prompts);
    if (typed === null) return null;
    commands = typed;
    description = "owner-entered commands";
  }
  const timingLabel = await prompts.choose("When should these checks run?", Object.values(TIMING_LABELS));
  const timing = (Object.keys(TIMING_LABELS) as CheckTiming[]).find((key) => TIMING_LABELS[key] === timingLabel);
  if (timing === undefined) return null;
  return { kind: "change", settings: settingsForTiming(commands, timing), description };
};

/**
 * Without a terminal: one unambiguous, fully resolved plan, or announced empty
 * settings when nothing is recognized. Competing plans, unresolved parameters
 * and unreadable metadata require an explicit declaration instead of a guess.
 */
export const unattendedCheckSettings = (
  discovery: CheckDiscovery,
  context: { productRoot: string; configPath: string; examplePath: string }
): { settings: CheckSettings; description: string } => {
  const plans = discovery.plans;
  if (plans.length === 1 && plans[0]!.unresolved.length === 0) {
    const plan = plans[0]!;
    return { settings: plan.settings ?? settingsForTiming(plan.commands, "pull-request"), description: `${plan.detail} (${plan.source})` };
  }
  if (plans.length === 0 && discovery.problems.length === 0) return { settings: emptyCheckSettings(), description: "none configured" };
  const example = JSON.stringify({ verify: { precommit: [], prepush: [] },
    checks: plans[0]?.commands ?? [{ name: "test", argv: ["sh", "scripts/check.sh"] }] });
  throw new Error([
    plans.length === 0
      ? "Project build metadata could not be read, so onboarding cannot choose checks without a terminal:"
      : plans.length > 1
        ? "Several ways to check this project were found, and onboarding cannot choose between them without a terminal:"
        : "The detected check needs a choice onboarding cannot make without a terminal:",
    ...plans.map((plan, index) => `  ${index + 1}. ${planLabel(plan)}` +
      (plan.unresolved.length === 0 ? "" : ` — needs ${plan.unresolved.map((entry) => entry.placeholder).join(", ")}`)),
    ...discovery.problems.map((problem) => `  ${problem}`),
    `Run coord onboard ${context.productRoot} in a terminal to choose, or declare the commands explicitly:`,
    `  coord onboard ${context.productRoot} --declare <file.json>`,
    `  where the file contains, for example: ${example}`,
    `  Annotated example: ${context.examplePath}`,
    `Settings are saved in ${context.configPath}.`
  ].join("\n"));
};
