import { describe, it, expect } from "vitest";
import { AnyArtifactSchema } from "../src/protocol.js";

describe("protocol schemas", () => {
  it("parses a valid plan artifact", () => {
    const data = {
      type: "plan",
      issue: 1,
      agent: "Alice",
      content: "This is a plan",
      citations: [{ agent: "Bob" }]
    };
    const parsed = AnyArtifactSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid artifact type", () => {
    const data = {
      type: "unknown",
      issue: 1,
      agent: "Alice"
    };
    const parsed = AnyArtifactSchema.safeParse(data);
    expect(parsed.success).toBe(false);
  });
});
