import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, repoRoot } from "./support/workspaceFixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type BootstrapFixture = {
  root: string;
  source: string;
  origin: string;
  home: string;
  fakeBin: string;
  pnpmLog: string;
  env: NodeJS.ProcessEnv;
};

const fixture = (): BootstrapFixture => {
  const root = mkdtempSync(join(tmpdir(), "coord-bootstrap-"));
  roots.push(root);
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const home = join(root, "home");
  const fakeBin = join(root, "bin");
  const pnpmLog = join(root, "pnpm.log");
  mkdirSync(source);
  mkdirSync(home);
  mkdirSync(fakeBin);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: source });
  git(source, "config", "user.name", "Bootstrap fixture");
  git(source, "config", "user.email", "fixture@example.com");
  writeFileSync(join(source, "package.json"), "{\"name\":\"bootstrap-fixture\"}\n");
  writeFileSync(join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(source, ".gitignore"), "dist/\n");
  writeFileSync(join(source, "coord"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(source, "coord"), 0o755);
  mkdirSync(join(source, "scripts", "lib"), { recursive: true });
  writeFileSync(
    join(source, "scripts", "lib", "node-runtime.sh"),
    readFileSync(join(repoRoot, "scripts", "lib", "node-runtime.sh"), "utf8")
  );
  chmodSync(join(source, "scripts", "lib", "node-runtime.sh"), 0o755);
  git(source, "add", ".gitignore", "package.json", "pnpm-lock.yaml", "coord", "scripts/lib/node-runtime.sh");
  git(source, "commit", "-qm", "initial");
  git(source, "remote", "add", "origin", origin);
  git(source, "push", "-q", "-u", "origin", "main");

  writeFileSync(
    join(fakeBin, "node"),
    "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then printf 'v26.0.0\\n'; exit 0; fi\nexit 0\n"
  );
  chmodSync(join(fakeBin, "node"), 0o755);
  writeFileSync(
    join(fakeBin, "pnpm"),
    "#!/bin/sh\n" +
      "printf '%s (node=%s)\\n' \"$*\" \"$(node --version)\" >>\"$BOOTSTRAP_PNPM_LOG\"\n" +
      "if [ \"${1:-}\" = build ]; then mkdir -p dist; printf 'built\\n' >dist/main.js; fi\n"
  );
  chmodSync(join(fakeBin, "pnpm"), 0o755);
  return {
    root,
    source,
    origin,
    home,
    fakeBin,
    pnpmLog,
    env: {
      ...process.env,
      COORD_NODE: "",
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      BOOTSTRAP_PNPM_LOG: pnpmLog
    }
  };
};

const bootstrap = (input: BootstrapFixture, args: readonly string[], env: NodeJS.ProcessEnv = input.env) =>
  spawnSync("/bin/sh", [join(repoRoot, "scripts", "bootstrap.sh"), ...args], {
    encoding: "utf8",
    env
  });

describe("coord bootstrap", () => {
  it("honors --root over the environment, builds, owns its clone, and manages the PATH link", () => {
    const input = fixture();
    const installRoot = join(input.root, "explicit-install");
    const ignoredRoot = join(input.root, "environment-install");
    const result = bootstrap(input, ["--root", installRoot, "--source", input.origin], {
      ...input.env,
      COORD_INSTALL_ROOT: ignoredRoot
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(installRoot, "dist", "main.js"))).toBe(true);
    expect(existsSync(ignoredRoot)).toBe(false);
    expect(readFileSync(input.pnpmLog, "utf8").trim().split("\n")).toEqual([
      "install --frozen-lockfile (node=v26.0.0)",
      "build (node=v26.0.0)"
    ]);
    expect(readFileSync(join(installRoot, ".git", "coord-bootstrap.json"), "utf8")).toContain(
      '"ownsInstallRoot": true'
    );
    expect(readlinkSync(join(input.home, ".local", "bin", "coord"))).toBe(join(installRoot, "coord"));

    const rerun = bootstrap(input, ["--root", installRoot, "--source", input.origin]);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(git(installRoot, "status", "--porcelain")).toBe("");
  });

  it("fast-forwards a clean checkout and refuses a dirty one without moving HEAD", () => {
    const input = fixture();
    const installRoot = join(input.root, "install");
    expect(bootstrap(input, ["--root", installRoot, "--source", input.origin, "--no-path"]).status).toBe(0);

    writeFileSync(join(input.source, "version.txt"), "two\n");
    git(input.source, "add", "version.txt");
    git(input.source, "commit", "-qm", "advance");
    git(input.source, "push", "-q", "origin", "main");
    const advanced = git(input.source, "rev-parse", "HEAD");
    expect(bootstrap(input, ["--root", installRoot, "--source", input.origin, "--no-path"]).status).toBe(0);
    expect(git(installRoot, "rev-parse", "HEAD")).toBe(advanced);

    writeFileSync(join(installRoot, "dirty.txt"), "keep me\n");
    writeFileSync(join(input.source, "version.txt"), "three\n");
    git(input.source, "add", "version.txt");
    git(input.source, "commit", "-qm", "advance again");
    git(input.source, "push", "-q", "origin", "main");
    const before = git(installRoot, "rev-parse", "HEAD");
    const refused = bootstrap(input, ["--root", installRoot, "--source", input.origin, "--no-path"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("install root is dirty");
    expect(git(installRoot, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(installRoot, "dirty.txt"), "utf8")).toBe("keep me\n");
  });

  it("does not claim a pre-existing checkout and refuses foreign launchers and missing tools", () => {
    const input = fixture();
    const developerRoot = join(input.root, "developer-install");
    execFileSync("git", ["clone", "-q", "--branch", "main", input.origin, developerRoot]);
    expect(bootstrap(input, ["--root", developerRoot, "--source", input.origin, "--no-path"]).status).toBe(0);
    expect(existsSync(join(developerRoot, ".git", "coord-bootstrap.json"))).toBe(false);

    const launcher = join(input.home, ".local", "bin", "coord");
    mkdirSync(join(input.home, ".local", "bin"), { recursive: true });
    symlinkSync("/foreign/coord", launcher);
    const foreign = bootstrap(input, ["--root", developerRoot, "--source", input.origin]);
    expect(foreign.status).not.toBe(0);
    expect(foreign.stderr).toContain("already exists and is not the managed link");
    expect(readlinkSync(launcher)).toBe("/foreign/coord");

    const missing = bootstrap(input, ["--root", join(input.root, "missing-tools"), "--source", input.origin], {
      ...input.env,
      PATH: "/usr/bin:/bin"
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Node 26 and pnpm 11 are required");
  });

  it("uses Node >=26 from NVM_DIR when PATH has Node 16 and fails when only Node 16 exists", () => {
    const input = fixture();
    writeFileSync(
      join(input.fakeBin, "node"),
      "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then printf 'v16.18.0\\n'; exit 0; fi\nexit 0\n"
    );
    chmodSync(join(input.fakeBin, "node"), 0o755);

    const tooOld = bootstrap(input, ["--root", join(input.root, "too-old"), "--source", input.origin, "--no-path"], {
      ...input.env,
      NVM_DIR: join(input.root, "empty-nvm"),
      PATH: `${input.fakeBin}:/usr/bin:/bin`
    });
    expect(tooOld.status).not.toBe(0);
    expect(tooOld.stderr).toContain("Node 26 and pnpm 11 are required");

    const nvmBin = join(input.root, "nvm", "versions", "node", "v26.1.0", "bin");
    mkdirSync(nvmBin, { recursive: true });
    writeFileSync(
      join(nvmBin, "node"),
      "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then printf 'v26.1.0\\n'; exit 0; fi\nexit 0\n"
    );
    chmodSync(join(nvmBin, "node"), 0o755);

    const ok = bootstrap(input, ["--root", join(input.root, "with-nvm"), "--source", input.origin, "--no-path"], {
      ...input.env,
      NVM_DIR: join(input.root, "nvm"),
      PATH: `${input.fakeBin}:/usr/bin:/bin`
    });
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(input.pnpmLog, "utf8").trim().split("\n")).toEqual([
      "install --frozen-lockfile (node=v26.1.0)",
      "build (node=v26.1.0)"
    ]);
  });
});
