import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { git } from "./gitExec.js";
import type { CheckCommand, VerifyConfig } from "./state.js";

/**
 * Guided build/test check discovery (#261).
 *
 * Discovery reads repository files only: it never executes project code,
 * never calls GitHub, and never interprets CI YAML as a runnable plan.
 * Every plan names the file that justifies it; test sources and CI
 * workflows are context evidence, never selections. Anything the detector
 * cannot resolve deterministically is reported as unresolved so the owner
 * (or an explicit declaration) decides — nothing is guessed.
 */

export type CheckPlan = {
  label: string;
  /** Repository-relative file that justifies this plan. */
  source: string;
  commands: CheckCommand[];
  /** Owner-supplied values still needed before these commands can run. */
  unresolved: string[];
};

export type CheckEvidence = { path: string; label: string };

export type CheckDiscovery = {
  plans: CheckPlan[];
  evidence: CheckEvidence[];
};

export type CheckTiming = "commit" | "pr" | "both" | "none";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".build", "DerivedData", "Pods"]);
const MAX_WALK_ENTRIES = 4000;

const listFiles = (root: string): string[] => {
  const tracked = git(root, "ls-files");
  if (tracked.exitCode === 0 && tracked.stdout.trim() !== "") {
    return tracked.stdout.split("\n").filter((entry) => entry !== "");
  }
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= MAX_WALK_ENTRIES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_WALK_ENTRIES) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        found.push(relative(root, join(dir, entry.name)).split("\\").join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
};

const readText = (root: string, path: string): string | null => {
  try { return readFileSync(join(root, path), "utf8"); } catch { return null; }
};

/** CMake preset chain: configure -> build -> test, in that order. */
const cmakePlans = (root: string, has: (path: string) => boolean): CheckPlan[] => {
  if (!has("CMakePresets.json")) return [];
  const presets = readJson(join(root, "CMakePresets.json"));
  if (presets === null) return [];
  const names = (key: string): string[] => {
    const list = presets[key];
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      return typeof record.name === "string" && record.hidden !== true ? [record.name] : [];
    });
  };
  const configure = names("configurePresets");
  const build = names("buildPresets");
  const test = names("testPresets");
  const plans: CheckPlan[] = [];
  for (const testName of test) {
    const configureName = configure[0];
    const buildName = build[0];
    if (configureName === undefined || buildName === undefined) continue;
    plans.push({
      label: `CMake presets: configure → build → test (${testName})`,
      source: "CMakePresets.json",
      commands: [
        { name: "configure", argv: ["cmake", "--preset", configureName] },
        { name: "build", argv: ["cmake", "--build", "--preset", buildName] },
        { name: "test", argv: ["ctest", "--preset", testName, "--output-on-failure", "--no-tests=error"] }
      ],
      unresolved: configure.length > 1 || build.length > 1 || test.length > 1
        ? ["which configure/build/test presets apply"] : []
    });
  }
  if (plans.length === 0 && configure[0] !== undefined && build[0] !== undefined) {
    plans.push({
      label: `CMake presets: configure → build (${configure[0]}, no test preset)`,
      source: "CMakePresets.json",
      commands: [
        { name: "configure", argv: ["cmake", "--preset", configure[0]] },
        { name: "build", argv: ["cmake", "--build", "--preset", build[0]] }
      ],
      unresolved: []
    });
  }
  return plans;
};

/** Xcode plans from checked-in shared schemes; the destination is never guessed. */
const xcodePlans = (root: string, files: readonly string[]): CheckPlan[] => {
  const plans: CheckPlan[] = [];
  const containers = files.filter((path) => /\.(xcodeproj|xcworkspace)$/.test(path.split("/")[0] ?? ""));
  const topContainers = [...new Set(containers.map((path) => path.split("/")[0] as string))]
    .filter((name) => !name.includes("/"));
  const schemes = files.filter((path) => path.includes("xcshareddata/xcschemes/") && path.endsWith(".xcscheme"));
  for (const schemePath of schemes) {
    const xml = readText(root, schemePath);
    if (xml === null || !xml.includes("TestableReference")) continue;
    const scheme = (schemePath.split("/").pop() as string).replace(/\.xcscheme$/, "");
    const container = topContainers.find((name) => schemePath.startsWith(`${name}/`)) ?? topContainers[0];
    if (container === undefined) continue;
    const flag = container.endsWith(".xcworkspace") ? "-workspace" : "-project";
    plans.push({
      label: `Xcode scheme ${scheme} (${container})`,
      source: schemePath,
      commands: [{ name: "test", argv: ["xcodebuild", "test", flag, container, "-scheme", scheme] }],
      unresolved: ["destination (for example platform=macOS,arch=arm64)"]
    });
  }
  return plans;
};

export const discoverChecks = (productRoot: string): CheckDiscovery => {
  const root = productRoot;
  const files = listFiles(root);
  const fileSet = new Set(files);
  const has = (path: string): boolean => fileSet.has(path) || existsSync(join(root, path));
  const plans: CheckPlan[] = [];
  const evidence: CheckEvidence[] = [];

  for (const path of files) {
    if (/^scripts\/[^/]+\.sh$/.test(path)) {
      plans.push({ label: `sh ${path}`, source: path, commands: [{ name: "check", argv: ["sh", path] }], unresolved: [] });
    }
    if (/^(test|tests|Tests)\//.test(path) && /\.(cpp|cc|cxx|m|mm|swift|ts|js|py|go|rs)$/.test(path)) {
      evidence.push({ path, label: "test source (context, not a runnable command)" });
    }
    if (path.startsWith(".github/workflows/")) {
      evidence.push({ path, label: "CI workflow (supporting evidence, not run)" });
    }
  }
  if (has("CMakeLists.txt")) evidence.push({ path: "CMakeLists.txt", label: "CMake project" });

  plans.push(...cmakePlans(root, has));
  plans.push(...xcodePlans(root, files));

  if (has("Package.swift") && !files.some((path) => path.endsWith(".xcodeproj/project.pbxproj"))) {
    plans.push({
      label: "Swift package: build then test",
      source: "Package.swift",
      commands: [
        { name: "build", argv: ["swift", "build"] },
        { name: "test", argv: ["swift", "test"] }
      ],
      unresolved: []
    });
  }
  if (has("Cargo.toml")) {
    plans.push({ label: "cargo test", source: "Cargo.toml",
      commands: [{ name: "test", argv: ["cargo", "test"] }], unresolved: [] });
  }
  if (has("go.mod")) {
    plans.push({ label: "go build and test", source: "go.mod",
      commands: [
        { name: "build", argv: ["go", "build", "./..."] },
        { name: "test", argv: ["go", "test", "./..."] }
      ], unresolved: [] });
  }
  const pkg = has("package.json") ? readJson(join(root, "package.json")) : null;
  if (pkg !== null) {
    const scripts = typeof pkg.scripts === "object" && pkg.scripts !== null
      ? pkg.scripts as Record<string, unknown> : {};
    const manager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const run = (name: string): CheckCommand => ({
      name, argv: manager === "npm" ? ["npm", "run", "--silent", name] : [manager, "run", name]
    });
    const script = ["check", "test"].find((name) => typeof scripts[name] === "string");
    if (script !== undefined) {
      plans.push({ label: `${manager} run ${script}`, source: "package.json", commands: [run(script)], unresolved: [] });
    }
  }
  const makefile = readText(root, "Makefile");
  if (makefile !== null && /^test:/m.test(makefile)) {
    plans.push({ label: "make test", source: "Makefile",
      commands: [{ name: "test", argv: ["make", "test"] }], unresolved: [] });
  }
  if (["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"].some(has)) {
    plans.push({ label: "pytest -q", source: "pyproject.toml",
      commands: [{ name: "test", argv: ["pytest", "-q"] }], unresolved: [] });
  }
  return { plans, evidence };
};

/**
 * The single plan a noninteractive run may adopt, or the reason it may not.
 * Several plans, or one plan with unresolved parameters, require an
 * explicit owner choice instead of an arbitrary pick.
 */
export const resolveUnambiguousPlan = (
  discovery: CheckDiscovery
): { plan: CheckPlan | null; ambiguous: boolean } => {
  if (discovery.plans.length === 0) return { plan: null, ambiguous: false };
  if (discovery.plans.length === 1 && (discovery.plans[0] as CheckPlan).unresolved.length === 0) {
    return { plan: discovery.plans[0] as CheckPlan, ambiguous: false };
  }
  return { plan: null, ambiguous: true };
};

/**
 * Quote-aware command tokenizer for owner-typed commands. Arguments are
 * preserved exactly (including spaces and empty quoted arguments); shell
 * operators are refused so typed text is never executed through a shell.
 */
export const parseCommandLine = (text: string): string[] => {
  const argv: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quote !== null) {
      if (char === quote) { quote = null; continue; }
      if (char === "\\" && quote === '"' && index + 1 < text.length) {
        current += text[index + 1]; index++; continue;
      }
      current += char; continue;
    }
    if (char === "'" || char === '"') { quote = char; hasCurrent = true; continue; }
    if (char === "\\" && index + 1 < text.length) { current += text[index + 1]; index++; hasCurrent = true; continue; }
    if (/\s/.test(char)) {
      if (hasCurrent || current !== "") { argv.push(current); current = ""; hasCurrent = false; }
      continue;
    }
    if ("|&;<>$`".includes(char)) {
      throw new Error(
        `Shell operator '${char}' is not allowed in a typed command; put pipelines or redirection in a checked-in script and select that script instead.`
      );
    }
    current += char; hasCurrent = true;
  }
  if (quote !== null) throw new Error("Unmatched quote in command; fix the quoting or use a checked-in script.");
  if (hasCurrent || current !== "") argv.push(current);
  if (argv.length === 0) throw new Error("Command is empty.");
  return argv;
};

/** Map an owner's timing choice onto the existing verify/checks lists. */
export const settingsForTiming = (
  commands: readonly CheckCommand[], timing: CheckTiming
): { verify: VerifyConfig; checks: CheckCommand[] } => {
  const list = commands.map((command) => ({ ...command, argv: [...command.argv] }));
  switch (timing) {
    case "commit": return { verify: { precommit: list, prepush: [] }, checks: [] };
    case "pr": return { verify: { precommit: [], prepush: [] }, checks: list };
    case "both": return { verify: { precommit: list, prepush: [] }, checks: list.map((command) => ({ ...command })) };
    case "none": return { verify: { precommit: [], prepush: [] }, checks: [] };
  }
};

export const NO_CHECKS_MESSAGE = "Automated checks skipped: none configured.";

/** Plain-language outcome wording; a build is never reported as a test. */
export const describeCheckOutcome = (
  commands: readonly CheckCommand[],
  results?: readonly { name: string; exitCode: number }[]
): string => {
  if (commands.length === 0) return NO_CHECKS_MESSAGE;
  const failed = results?.find((result) => result.exitCode !== 0);
  const outcome = results === undefined ? "not run" : failed === undefined ? "passed" : `failed (${failed.name} exited ${failed.exitCode})`;
  const buildOnly = commands.every((command) => ["configure", "build"].includes(command.name));
  const listing = commands.map((command) => `${command.name}: ${command.argv.join(" ")}`).join("; ");
  return buildOnly ? `Build result: ${outcome} (${listing})` : `Build and test result: ${outcome} (${listing})`;
};
