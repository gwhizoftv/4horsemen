import { z } from "zod";
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { startJsonPath, cursorsJsonPath, journalPath, issueDir, agentDir } from "./paths.js";
import { MAX_REVISION_ROUNDS } from "./steps.js";

const sha40 = z.string().regex(/^[a-f0-9]{40}$/);

// --- start.json schema ---
export const StartSchema = z.object({
  formatVersion: z.literal(1),
  issue: z.number().int().min(1),
  issueSessionId: z.string().regex(/^issue-\d+:[a-f0-9]{40}$/),
  baselineSha: sha40,
  profile: z.enum(["solo", "reviewed", "consensus"]),
  roster: z.array(z.string().min(1)).min(1),
  baseBranch: z.string().min(1),
  maxRevisionRounds: z.number().int().min(1).default(MAX_REVISION_ROUNDS),
  prPolicy: z.enum(["owner-only", "coord-open-unmerged"]),
  automationDigest: z.string().min(1),
  automationDigestScheme: z.string().min(1),
  trustedSourceCommit: sha40,
  createdAt: z.string().datetime(),
});
export type StartConfig = z.infer<typeof StartSchema>;

// --- Agent cursor status ---
export type AgentStatus = "ordered" | "running" | "intent" | "verifying" | "waiting-peer" | "waiting-input" | "paused" | "complete" | "failed" | "harness-gone";

export const AgentCursorSchema = z.object({
  stepId: z.string(),
  actionId: z.string(),
  status: z.enum(["ordered", "running", "intent", "verifying", "waiting-peer", "waiting-input", "paused", "complete", "failed", "harness-gone"]),
  attempt: z.number().int().min(1),
  delivery: z.enum(["nudge", "pull", "both"]),
  submissionSha: z.string().nullable(),
  outstanding: z.array(z.object({ code: z.string(), message: z.string() })),
  updatedAt: z.string().datetime(),
});
export type AgentCursor = z.infer<typeof AgentCursorSchema>;

export const CursorsSchema = z.object({
  issueCursor: z.object({
    gateId: z.string(),
    round: z.number().int().min(1).nullable(),
  }),
  agents: z.record(z.string(), AgentCursorSchema),
  droppedAgents: z.array(z.string()).default([]),
  paused: z.boolean().default(false),
});
export type Cursors = z.infer<typeof CursorsSchema>;

// --- Journal entry ---
export interface JournalEntry {
  timestamp: string;
  event: string;
  [key: string]: unknown;
}

// --- Atomic file I/O ---

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Write JSON atomically using write-to-temp + rename. */
export function writeJsonAtomic(path: string, data: unknown): void {
  ensureDir(path);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Read and validate start.json. */
export function readStart(coordRoot: string, issue: number): StartConfig {
  const path = startJsonPath(coordRoot, issue);
  const raw = readFileSync(path, "utf8");
  return StartSchema.parse(JSON.parse(raw));
}

/** Write start.json atomically. */
export function writeStart(coordRoot: string, issue: number, config: StartConfig): void {
  writeJsonAtomic(startJsonPath(coordRoot, issue), config);
}

/** Read and validate cursors.json. */
export function readCursors(coordRoot: string, issue: number): Cursors {
  const path = cursorsJsonPath(coordRoot, issue);
  const raw = readFileSync(path, "utf8");
  return CursorsSchema.parse(JSON.parse(raw));
}

/** Write cursors.json atomically. */
export function writeCursors(coordRoot: string, issue: number, cursors: Cursors): void {
  writeJsonAtomic(cursorsJsonPath(coordRoot, issue), cursors);
}

/** Append an entry to journal.jsonl. */
export function appendJournal(coordRoot: string, issue: number, entry: JournalEntry): void {
  const path = journalPath(coordRoot, issue);
  ensureDir(path);
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

/** Read all journal entries. */
export function readJournal(coordRoot: string, issue: number): JournalEntry[] {
  const path = journalPath(coordRoot, issue);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(l => l.trim().length > 0);
  return lines.map(l => JSON.parse(l) as JournalEntry);
}

/** Ensure the directory structure for an issue exists. */
export function ensureIssueStructure(coordRoot: string, issue: number, agents: readonly string[]): void {
  mkdirSync(issueDir(coordRoot, issue), { recursive: true });
  for (const agent of agents) {
    mkdirSync(agentDir(coordRoot, issue, agent), { recursive: true });
  }
}
