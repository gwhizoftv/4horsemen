import { describe, it, expect } from "vitest";
import { parseCli } from "../src/cli.js";
import { resolve } from "node:path";

describe("cli", () => {
  it("parses valid command", () => {
    const res = parseCli(["node", "coord", "start", "--coord-root", "/tmp/coord"]);
    expect(res.cmd).toBe("start");
    expect(res.coordRoot).toBe(resolve("/tmp/coord"));
  });
  
  it("throws if no coord root", () => {
    expect(() => parseCli(["node", "coord", "start"])).toThrow(/required/);
  });
});
