import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const sha256 = (input: string | Uint8Array): string => {
  const hash = createHash("sha256");

  if (typeof input === "string") {
    hash.update(input, "utf8");
  } else {
    hash.update(input);
  }

  return hash.digest("hex");
};

export const sha256OfFile = (path: string): string => sha256(readFileSync(path));
