import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, sha256OfFile } from "../src/hash.js";

describe("SHA-256 helpers", () => {
  it("hashes strings as exact UTF-8 bytes", () => {
    expect(sha256("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("hashes file bytes without normalizing line endings", () => {
    const directory = mkdtempSync(join(tmpdir(), "automation-hash-"));
    const path = join(directory, "coordinationFile.txt");
    const bytes = Buffer.from("first\r\nsecond\n", "utf8");

    try {
      writeFileSync(path, bytes);

      expect(sha256OfFile(path)).toBe(sha256(bytes));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
