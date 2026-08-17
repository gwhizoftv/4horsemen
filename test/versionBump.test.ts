import { describe, expect, it } from "vitest";
import {
  checkVersionBump,
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

describe("version bump ship gate", () => {
  it("requires package.json to advance past origin/main on non-main branches", () => {
    const result = checkVersionBump(process.cwd(), {
      baseRef: process.env.COORD_VERSION_BASE_REF ?? "origin/main"
    });
    expect(result.ok, result.detail).toBe(true);
  });
});
