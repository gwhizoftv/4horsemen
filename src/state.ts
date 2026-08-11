import { z } from "zod";
import { writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { resolveIssueRoot } from "./paths.js";
import { join } from "node:path";

export const StartStateSchema = z.object({
  formatVersion: z.number().int().positive(),
  issue: z.number().int().positive(),
  originalRoster: z.array(z.string()),
  branchTemplate: z.string(),
  digest: z.string(),
  sourceCommit: z.string(),
  prPolicy: z.enum(["unmerged", "none"]),
  revisionLimit: z.number().int().nonnegative().default(3)
});
export type StartState = z.infer<typeof StartStateSchema>;

export const CursorStateSchema = z.record(z.string(), z.string());
export type CursorState = z.infer<typeof CursorStateSchema>;

export const JournalEntrySchema = z.object({
  timestamp: z.string(),
  action: z.string(),
  payload: z.any()
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

const writeAtomicJson = (path: string, data: unknown) => {
  const tmp = `${path}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
};

export const initializeState = (coordRoot: string, startState: StartState) => {
  const root = resolveIssueRoot(coordRoot, startState.issue);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  writeAtomicJson(join(root, "start.json"), startState);
  writeAtomicJson(join(root, "cursors.json"), {});
  writeFileSync(join(root, "journal.jsonl"), "", "utf8");
};

export const updateCursors = (coordRoot: string, issue: number, cursors: CursorState) => {
  const root = resolveIssueRoot(coordRoot, issue);
  writeAtomicJson(join(root, "cursors.json"), cursors);
};

export const appendJournal = (coordRoot: string, issue: number, entry: JournalEntry) => {
  const root = resolveIssueRoot(coordRoot, issue);
  appendFileSync(join(root, "journal.jsonl"), JSON.stringify(entry) + "\n", "utf8");
};

export const pauseWorkflow = (coordRoot: string, issue: number) => {
  const root = resolveIssueRoot(coordRoot, issue);
  writeFileSync(join(root, "pause"), "", "utf8");
};

export const resumeWorkflow = (coordRoot: string, issue: number) => {
  const root = resolveIssueRoot(coordRoot, issue);
  const path = join(root, "pause");
  if (existsSync(path)) {
    import("node:fs").then(fs => fs.unlinkSync(path));
  }
};
