import { randomUUID } from "node:crypto";
import { existsSync, opendirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { git, localConfigGet } from "./gitExec.js";
import { assertNoSymlink, issueRuntimePaths, type IssueRuntimePaths } from "./paths.js";
import { appendJournal, atomicWriteJson, checkCommandSchema, readJournal, readStartState, type StartState } from "./state.js";
import { workspaceLocationFromConfig } from "./workspace.js";

/** Advisory observations, never verification receipts or gate authority. */
export const verificationMeasurementSchema = z.object({
  measurementId: z.uuid(),
  trigger: z.enum(["hook", "coordinator"]),
  phase: z.enum(["precommit", "prepush", "candidate", "finalization"]),
  inputIdentity: z.string().min(1),
  classification: z.enum(["coordination", "documentation", "product"]),
  reason: z.string(),
  command: checkCommandSchema.nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  durationMs: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int(),
  skipReason: z.string().nullable(),
  cacheReason: z.string().min(1),
  attempt: z.number().int().min(1).optional(),
  queueWaitMs: z.number().int().nonnegative().optional(),
  logPath: z.string().optional(),
  receiptId: z.string().optional(),
  error: z.string().optional()
}).strict();
export type VerificationMeasurement = z.infer<typeof verificationMeasurementSchema>;

export const verificationMeasurement = (
  input: Omit<VerificationMeasurement, "measurementId" | "durationMs" | "cacheReason"> & { cacheReason?: string }
): VerificationMeasurement => {
  const duration = Date.parse(input.completedAt) - Date.parse(input.startedAt);
  return { ...input, measurementId: randomUUID(), cacheReason: input.cacheReason ?? "not cached: hook",
    durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null };
};

const mailbox = (clone: string): string => join(clone, ".coord", "verification");
const envelopeSchema = z.object({
  issueSessionId: z.string().nullable(),
  agent: z.string().nullable(),
  measurement: verificationMeasurementSchema
}).strict();

/** Bind automated observations to the actual branch/session, not a possibly
 * stale COORD_ISSUE environment. Unattributable observations are not queued. */
export const hookVerificationRecorder = (clone: string, configPath: string, warn: (message: string) => void) => {
  let issueSessionId: string | null = null;
  let agent: string | null = null;
  try {
    agent = localConfigGet(clone, "consensus.agentId");
    const branch = git(clone, "symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim();
    const match = /^issue-([1-9][0-9]*)\/([a-z0-9-]+)$/.exec(branch);
    if (match !== null && match[2] === agent) {
      const start = readStartState(issueRuntimePaths(workspaceLocationFromConfig(configPath).workspaceRoot, Number(match[1])));
      if (start.agents.some((entry) => entry.id === agent && resolve(entry.root) === resolve(clone))) issueSessionId = start.issueSessionId;
    }
  } catch { /* Manual branches and legacy installs have no active runtime. */ }
  return (measurement: VerificationMeasurement): void => {
    if (issueSessionId === null) {
      warn("coord: verification measurement not recorded: no readable matching issue session (checks are unchanged).\n");
      return;
    }
    try {
      const path = join(mailbox(clone), `${measurement.measurementId}.json`);
      assertNoSymlink(clone, path);
      atomicWriteJson(clone, path, envelopeSchema.parse({ issueSessionId, agent, measurement }));
    } catch (error) { warn(`coord: verification measurement unavailable: ${String(error)}\n`); }
  };
};

/** One ingestor per coordinator owner. Seed replay protection once from the
 * journal, then maintain it in memory; restart rebuilds it before draining.
 * measurementId deliberately does not invoke appendJournal's per-event scan.
 * Append before unlink so a crash cannot silently discard an observed runner. */
export const createVerificationIngestor = () => {
  let journalKey = "";
  let seen: Set<string> | undefined;
  return (paths: IssueRuntimePaths, clone: string, agent: string, start: StartState, now: string): void => {
    const root = mailbox(clone);
    if (!existsSync(root)) return;
    try {
      assertNoSymlink(clone, root);
      const key = `${paths.journal}:${start.issueSessionId}:${start.createdAt}:${statSync(paths.journal).ino}`;
      if (key !== journalKey) { journalKey = key; seen = undefined; }
      const directory = opendirSync(root);
      try {
        // Bound directory traversal as well as file reads per agent/tick.
        for (let count = 0; count < 128; count++) {
          const entry = directory.readSync();
          if (entry === null) break;
          if (!/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
          const path = join(root, entry.name);
          try {
            if (entry.isSymbolicLink()) { unlinkSync(path); continue; }
            assertNoSymlink(clone, path);
            const stat = statSync(path);
            if (!stat.isFile()) continue;
            if (stat.size > 65536) { unlinkSync(path); continue; }
            let row: z.infer<typeof envelopeSchema>;
            try { row = envelopeSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
            catch { unlinkSync(path); continue; }
            const measurement = row.measurement;
            const from = Date.parse(measurement.startedAt), to = Date.parse(measurement.completedAt);
            if (row.agent !== agent || row.issueSessionId !== start.issueSessionId || measurement.trigger !== "hook" ||
              entry.name !== `${measurement.measurementId}.json` || !["precommit", "prepush"].includes(measurement.phase) ||
              from < Date.parse(start.createdAt) - 60_000 || from > to || to > Date.parse(now) + 60_000 ||
              measurement.durationMs !== to - from) {
              unlinkSync(path);
              continue;
            }
            seen ??= new Set(readJournal(paths).filter((event) => event.type === "verification-run")
              .map((event) => event.details.measurementId).filter((id): id is string => typeof id === "string"));
            if (!seen.has(measurement.measurementId)) {
              appendJournal(paths, { type: "verification-run", agent,
                details: { ...measurement, source: "advisory hook observation" } }, now);
              seen.add(measurement.measurementId);
            }
            unlinkSync(path);
          } catch { /* Retry write failures; one bad record cannot stop the tick. */ }
        }
      } finally { directory.closeSync(); }
    } catch { /* Advisory telemetry must not stop the workflow. */ }
  };
};
