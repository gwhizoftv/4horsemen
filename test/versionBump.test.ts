import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bumpManifestSource,
  bumpPatchVersion,
  isStrictlyGreater,
  parseDotVersion
} from "../src/versionBump.js";

describe("version bump compare", () => {
  it("parses dotted triples and rejects other shapes", () => {
    expect(parseDotVersion("0.0.3")).toEqual([0, 0, 3]);
    expect(parseDotVersion("1.2.10")).toEqual([1, 2, 10]);
    expect(parseDotVersion("0.0.3-beta")).toBeNull();
    expect(parseDotVersion("v0.0.3")).toBeNull();
  });

  it("orders versions strictly", () => {
    expect(isStrictlyGreater([0, 0, 4], [0, 0, 3])).toBe(true);
    expect(isStrictlyGreater([0, 1, 0], [0, 0, 9])).toBe(true);
    expect(isStrictlyGreater([0, 0, 3], [0, 0, 3])).toBe(false);
    expect(isStrictlyGreater([0, 0, 2], [0, 0, 3])).toBe(false);
  });
});

describe("bumpPatchVersion", () => {
  it("advances the patch and leaves major and minor alone", () => {
    expect(bumpPatchVersion("0.0.20")).toBe("0.0.21");
    expect(bumpPatchVersion("1.2.3")).toBe("1.2.4");
  });

  it("carries past a digit boundary without widening the triple", () => {
    expect(bumpPatchVersion("0.0.9")).toBe("0.0.10");
    expect(bumpPatchVersion("0.0.99")).toBe("0.0.100");
  });

  it("refuses anything that is not a dotted triple", () => {
    expect(bumpPatchVersion("0.0.3-beta")).toBeNull();
    expect(bumpPatchVersion("v0.0.3")).toBeNull();
    expect(bumpPatchVersion("")).toBeNull();
  });
});

/**
 * Shaped like the real manifest on purpose: single-line `dependencies` and
 * `engines` objects are exactly what a parse-mutate-stringify rewrite would
 * silently expand, so they belong in the fixture the byte-stability case reads.
 */
const manifest = (version: string): string =>
  `{
  "name": "@coord/coordination",
  "version": "${version}",
  "private": true,
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "zod": "^4.4.3" },
  "engines": { "node": ">=26.0.0" }
}
`;

describe("bumpManifestSource", () => {
  it("reports the old and new versions", () => {
    const result = bumpManifestSource(manifest("0.0.20"));
    expect(result.from).toBe("0.0.20");
    expect(result.to).toBe("0.0.21");
  });

  it("rewrites the version line and no other byte", () => {
    const before = manifest("0.0.20");
    const after = bumpManifestSource(before).source;
    // Line-by-line rather than a whole-string compare: a helper that produced
    // the right version while reformatting `dependencies` onto three lines would
    // still satisfy a "contains 0.0.21" assertion, and is exactly the regression
    // this case exists to catch.
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines).toHaveLength(beforeLines.length);
    const changed = beforeLines
      .map((line, index) => (line === afterLines[index] ? null : index))
      .filter((index): index is number => index !== null);
    expect(changed).toEqual([2]);
    expect(afterLines[2]).toBe('  "version": "0.0.21",');
  });

  it("refuses a manifest with no top-level version line", () => {
    const source = '{\n  "name": "@coord/coordination"\n}\n';
    expect(() => bumpManifestSource(source)).toThrow(/no top-level "version" line/);
  });

  it("refuses a manifest with more than one candidate version line", () => {
    const source = `{
  "name": "@coord/coordination",
  "version": "0.0.20",
  "packageManager": {
    "version": "11.10.0"
  }
}
`;
    expect(() => bumpManifestSource(source)).toThrow(/2 candidate "version" lines/);
  });

  it("refuses a version that is not a dotted triple", () => {
    expect(() => bumpManifestSource(manifest("0.0.20-beta"))).toThrow(/not a dotted triple/);
  });

  it("refuses when the one matched line is not the manifest's own version", () => {
    // The package's version shares a line with another key, so it never starts a
    // line and the pattern cannot see it; the nested one does. Exactly one match,
    // and it is the wrong one — which is the case the `JSON.parse` cross-check
    // exists to catch, and the case a match-count check alone would sail past.
    const source = `{
  "name": "@coord/coordination", "version": "0.0.20",
  "tooling": {
    "version": "11.10.0"
  }
}
`;
    expect(() => bumpManifestSource(source)).toThrow(/JSON\.parse reports/);
  });

  it("bumps this repository's own package.json", () => {
    // The fixture cases all use a manifest this test file wrote. This one reads
    // the real file, which is the input the workflow actually hands the helper.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const source = readFileSync(join(root, "package.json"), "utf8");
    const result = bumpManifestSource(source);
    const parsed = JSON.parse(result.source) as { version: string; scripts: Record<string, string> };
    expect(parsed.version).toBe(result.to);
    expect(result.to).not.toBe(result.from);
    // Still the same manifest, not just still valid JSON.
    expect(parsed.scripts["bump-version"]).toBe("pnpm build && node dist/bumpVersion.js");
  });
});
