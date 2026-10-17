import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeFixture(root: string): { wrapper: string; bin: string } {
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  writeFileSync(join(root, "scripts/lib/node-runtime.sh"), readFileSync(resolve("scripts/lib/node-runtime.sh")), { mode: 0o700 });
  // An isolated PATH keeps a developer's system Node out of negative cases.
  for (const command of ["dirname", "readlink", "find", "grep"]) symlinkSync(`/usr/bin/${command}`, join(root, "bin", command));
  symlinkSync("/bin/bash", join(root, "bin/bash"));
  const wrapper = join(root, "coord");
  writeFileSync(wrapper, readFileSync(resolve("coord"), "utf8"), { mode: 0o700 });
  writeFileSync(join(root, "src/main.ts"), "newer\n");
  writeFileSync(join(root, "dist/main.js"), "older\n");
  const old = new Date(Date.now() - 60_000);
  const fresh = new Date();
  utimesSync(join(root, "dist/main.js"), old, old);
  utimesSync(join(root, "src/main.ts"), fresh, fresh);
  writeFileSync(join(root, "bin/pnpm"), "#!/bin/sh\necho BUILD_BANNER\nprintf 'build_node=%s\\n' \"$(node --version)\"\n", { mode: 0o700 });
  writeNode(join(root, "bin/node"), "v26.0.0");
  chmodSync(wrapper, 0o700);
  return { wrapper, bin: join(root, "bin") };
}

function writeNode(path: string, version: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' '${version}'; exit 0; fi
printf '%s\\n' "cwd=$(pwd)" "exec_node=$0" "path=$PATH" "path_node=$(node --version)" '---' 'actionId: protocol-only'
printf 'arg=%s\\n' "$@"
`, { mode: 0o700 });
}

const environment = (root: string, bin: string): NodeJS.ProcessEnv => ({
  ...process.env, COORD_NODE: undefined, NVM_DIR: join(root, "nvm"), PATH: bin
});

describe("coord wrapper", () => {
  it("keeps stale-build output off protocol stdout", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: environment(root, bin)
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("---\nactionId: protocol-only\n");
    expect(result.stdout).not.toContain("BUILD_BANNER");
    expect(result.stderr).toContain("BUILD_BANNER");
  });

  it("resolves a PATH symlink to the install root before pnpm build", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-symlink-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const linkDir = join(root, "path-bin");
    mkdirSync(linkDir);
    const link = join(linkDir, "coord");
    symlinkSync(wrapper, link);
    const result = spawnSync(link, ["next"], {
      encoding: "utf8",
      env: environment(root, bin)
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("---\nactionId: protocol-only\n");
    expect(result.stderr).toContain("BUILD_BANNER");
  });

  it("preserves the caller cwd so relative product paths resolve there", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-cwd-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const caller = join(root, "caller");
    mkdirSync(caller);
    const result = spawnSync(wrapper, ["onboard", "./testapp"], {
      cwd: caller,
      encoding: "utf8",
      env: environment(root, bin)
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cwd=${realpathSync(caller)}`);
    expect(result.stderr).toContain("BUILD_BANNER");
  });

  it.each(["PATH", "nvm", "override"])("selects %s Node for the CLI and build while product children keep their Node", (source) => {
    const root = mkdtempSync(join(tmpdir(), "coord wrapper "));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    writeNode(join(bin, "node"), "v16.18.0");
    const selected = join(root, "nvm/versions/node/v26.10.0/bin/node");
    writeNode(selected, "v26.10.0");
    writeNode(join(root, "nvm/versions/node/v26.9.0/bin/node"), "v26.9.0");
    const env = environment(root, bin);
    if (source === "PATH") { env.PATH += `:${join(selected, "..")}`; env.NVM_DIR = join(root, "absent"); }
    if (source === "override") env.COORD_NODE = selected;
    const caller = join(root, "product");
    mkdirSync(caller);
    writeFileSync(join(caller, ".nvmrc"), "16\n");
    const result = spawnSync(wrapper, ["onboard", "./product with spaces"], { cwd: caller, encoding: "utf8", env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("build_node=v26.10.0");
    expect(result.stdout).not.toContain("BUILD_BANNER");
    expect(result.stdout).toContain(`exec_node=${realpathSync(selected)}`);
    expect(result.stdout).toContain(`cwd=${realpathSync(caller)}`);
    expect(result.stdout).toContain(`path=${env.PATH}\n`);
    expect(result.stdout).toContain("path_node=v16.18.0");
    expect(result.stdout).toContain("arg=./product with spaces\n");
  });

  it.each(["v16.18.0", "v26.0.0-rc.1", "v26..0", "missing"])("rejects %s before building or loading the CLI", (version) => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-invalid-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    if (version === "missing") unlinkSync(join(bin, "node"));
    else writeNode(join(bin, "node"), version);
    const result = spawnSync(wrapper, ["next"], { encoding: "utf8", env: environment(root, bin) });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Node >= 26");
    expect(result.stderr).toContain("COORD_NODE");
    expect(result.stderr).not.toContain("BUILD_BANNER");
    if (version !== "missing") expect(result.stderr).toContain(version);
  });

  it("rejects an invalid override even with a compatible PATH and accepts future stable majors", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-override-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const override = join(root, "override/node");
    writeNode(override, "v25.0.0");
    const env = { ...environment(root, bin), COORD_NODE: override };
    expect(spawnSync(wrapper, [], { encoding: "utf8", env }).status).toBe(1);
    writeNode(override, "v27.0.0");
    expect(spawnSync(wrapper, [], { encoding: "utf8", env }).status).toBe(0);
    const engines = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { engines: { node: string } }).engines.node;
    const floor = /coord_min_major=(\d+)/.exec(readFileSync(resolve("scripts/lib/node-runtime.sh"), "utf8"))![1];
    expect(engines).toBe(`>=${floor}.0.0`);
  });
});
