import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { git, localConfigGet } from "./gitExec.js";
import { assertNoSymlink, issueRuntimePaths, type IssueRuntimePaths } from "./paths.js";
import { appendJournal, atomicWriteJson, checkCommandSchema, readStartState } from "./state.js";
import { workspaceLocationFromConfig } from "./workspace.js";

/** Advisory observations, never verification receipts or gate authority. */
export const verificationMeasurementSchema = z.object({
  eventId: z.uuid(),
  trigger: z.enum(["hook", "coordinator"]),
  phase: z.enum(["precommit", "prepush", "finalization"]),
  inputIdentity: z.string().min(1),
  classification: z.enum(["coordination", "documentation", "product"]),
  reason: z.string(),
  command: checkCommandSchema.nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  durationMs: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int(),
  skipReason: z.string().nullable(),
  cacheReason: z.literal("not implemented"),
  error: z.string().optional()
}).strict();
export type VerificationMeasurement = z.infer<typeof verificationMeasurementSchema>;

export const verificationMeasurement = (
  input: Omit<VerificationMeasurement, "eventId" | "durationMs" | "cacheReason">
): VerificationMeasurement => {
  const duration = Date.parse(input.completedAt) - Date.parse(input.startedAt);
  return { ...input, eventId: randomUUID(), cacheReason: "not implemented",
    durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null };
};

const mailbox = (clone: string): string => join(clone, ".coord", "verification");
const envelopeSchema = z.object({
  issueSessionId: z.string().nullable(),
  agent: z.string().nullable(),
  measurement: verificationMeasurementSchema
}).strict();

/** Bind automated observations to the actual branch/session, not a possibly
 * stale COORD_ISSUE environment. Manual hooks keep local, unattributed records. */
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
    try {
      const path = join(mailbox(clone), `${measurement.eventId}.json`);
      assertNoSymlink(clone, path);
      atomicWriteJson(clone, path, envelopeSchema.parse({ issueSessionId, agent, measurement }));
    } catch (error) { warn(`coord: verification measurement unavailable: ${String(error)}\n`); }
  };
};

/** Idempotent ingestion reuses journal eventId deduplication. Invalid, stale,
 * oversized or symlinked observations cannot affect any workflow decision. */
export const ingestVerificationMeasurements = (paths: IssueRuntimePaths, clone: string, agent: string): void => {
  const root = mailbox(clone);
  if (!existsSync(root)) return;
  try {
    assertNoSymlink(clone, root);
    const start = readStartState(paths);
    for (const name of readdirSync(root)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const path = join(root, name);
      try {
        assertNoSymlink(clone, path);
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > 65536) continue;
        const row = envelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        if (row.agent !== agent || row.issueSessionId !== start.issueSessionId || row.measurement.trigger !== "hook") continue;
        appendJournal(paths, { type: "verification-run", agent,
          details: { ...row.measurement, source: "advisory hook observation" } }, row.measurement.completedAt);
        unlinkSync(path);
      } catch { /* A malformed record must not prevent other observations. */ }
    }
  } catch { /* Advisory telemetry must not stop the workflow. */ }
};
