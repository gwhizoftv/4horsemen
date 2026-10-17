import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

const clearSelectorEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next = { ...env };
  delete next.COORD_NODE;
  delete next.NVM_DIR;
  return next;
};

const writeNodeStub = (path: string, version: string, body: string): void => {
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
${body}
`,
    { mode: 0o700 }
  );
  chmodSync(path, 0o700);
};

function writeFixture(root: string): { wrapper: string; bin: string } {
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  const wrapper = join(root, "coord");
  writeFileSync(wrapper, readFileSync(resolve("coord"), "utf8"), { mode: 0o700 });
  copyFileSync(resolve("scripts/lib/node-runtime.sh"), join(root, "scripts/lib/node-runtime.sh"));
  chmodSync(join(root, "scripts/lib/node-runtime.sh"), 0o755);
  writeFileSync(join(root, ".nvmrc"), "26\n");
  writeFileSync(join(root, "src/main.ts"), "newer\n");
  writeFileSync(join(root, "dist/main.js"), "older\n");
  const old = new Date(Date.now() - 60_000);
  const fresh = new Date();
  utimesSync(join(root, "dist/main.js"), old, old);
  utimesSync(join(root, "src/main.ts"), fresh, fresh);
  writeFileSync(
    join(root, "bin/pnpm"),
    "#!/bin/sh\nprintf 'BUILD_BANNER node=%s\\n' \"$(command -v node)\"\n",
    { mode: 0o700 }
  );
  chmodSync(join(root, "bin/pnpm"), 0o700);
  writeNodeStub(
    join(root, "bin/node"),
    "v26.0.0",
    `printf '%s\\n' "exec=$0" "cwd=$(pwd)" '---' 'actionId: protocol-only'`
  );
  chmodSync(wrapper, 0o700);
  return { wrapper, bin: join(root, "bin") };
}

describe("coord wrapper", () => {
  it("keeps stale-build output off protocol stdout", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: clearSelectorEnv({ ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home") })
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
      env: clearSelectorEnv({ ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home") })
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
      env: clearSelectorEnv({ ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home") })
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cwd=${realpathSync(caller)}`);
    expect(result.stderr).toContain("BUILD_BANNER");
  });

  it("selects a later PATH Node 26 when an older Node is first without changing PATH for the CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-select-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const oldBin = join(root, "old-bin");
    const goodBin = join(root, "good-bin");
    mkdirSync(oldBin);
    mkdirSync(goodBin);
    writeNodeStub(join(oldBin, "node"), "v16.18.0", `printf 'OLD_NODE_RAN\\n'; exit 99`);
    writeNodeStub(
      join(goodBin, "node"),
      "v26.1.0",
      `printf '%s\\n' "exec=$0" "path_node=$(command -v node)" "cwd=$(pwd)" '---' 'actionId: protocol-only'`
    );
    writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nprintf 'BUILD_BANNER\\n' >&2\n", { mode: 0o700 });
    const path = `${oldBin}:${goodBin}:${bin}:/usr/bin:/bin`;
    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: clearSelectorEnv({ ...process.env, PATH: path, HOME: join(root, "home") })
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`exec=${join(goodBin, "node")}`);
    expect(result.stdout).toContain(`path_node=${join(oldBin, "node")}`);
    expect(result.stdout).not.toContain("OLD_NODE_RAN");
  });

  it("falls back to nvm versions when PATH only has an old Node", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-nvm-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    writeNodeStub(join(bin, "node"), "v16.18.0", `printf 'OLD_NODE_RAN\\n'; exit 99`);
    const nvm = join(root, "nvm");
    const nvmNode = join(nvm, "versions/node/v26.7.0/bin");
    mkdirSync(nvmNode, { recursive: true });
    writeNodeStub(
      join(nvmNode, "node"),
      "v26.7.0",
      `printf '%s\\n' "exec=$0" "path_node=$(command -v node)" '---' 'actionId: protocol-only'`
    );
    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: { ...clearSelectorEnv(process.env), PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), NVM_DIR: nvm }
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`exec=${join(nvmNode, "node")}`);
    expect(result.stdout).toContain(`path_node=${join(bin, "node")}`);
    expect(result.stdout).not.toContain("OLD_NODE_RAN");
  });

  it("refuses before building when no qualifying Node exists", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-refuse-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    writeNodeStub(join(bin, "node"), "v16.18.0", `printf 'SHOULD_NOT_RUN\\n'`);
    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: clearSelectorEnv({ ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home") })
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(result.stderr).toContain("26");
    expect(result.stderr).toContain("v16.18.0");
    expect(result.stderr).toContain("COORD_NODE");
    expect(result.stderr).not.toContain("BUILD_BANNER");
  });

  it("honors COORD_NODE and refuses an invalid override", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-override-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    writeNodeStub(join(bin, "node"), "v16.18.0", `printf 'PATH_NODE\\n'`);
    const override = join(root, "override/node");
    mkdirSync(join(root, "override"));
    writeNodeStub(override, "v26.2.0", `printf '%s\\n' "exec=$0" '---' 'actionId: protocol-only'`);
    const ok = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), COORD_NODE: override }
    });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`exec=${override}`);

    const bad = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: join(root, "home"),
        COORD_NODE: join(bin, "node")
      }
    });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("COORD_NODE");
    expect(bad.stdout).not.toContain("PATH_NODE");
  });

  it("keeps .nvmrc major aligned with package.json engines.node", () => {
    const nvmrc = readFileSync(resolve(".nvmrc"), "utf8").trim();
    const engines = JSON.parse(readFileSync(resolve("package.json"), "utf8")).engines.node as string;
    expect(nvmrc).toMatch(/^\d+$/);
    expect(engines).toContain(`>=${nvmrc}.`);
  });
});
