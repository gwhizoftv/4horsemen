import type { BallotBatch, CursorsState, StartState } from "./state.js";
import { coordMergesPullRequest, describeWorkflowStep, type WorkflowStepId } from "./steps.js";
import { containmentCoverage, stopObservationWarning, type AgentLifecycleState } from "./agentLifecycle.js";
import { containmentPolicy } from "./shellGuard.js";
import { shellQuote } from "./agentHookSync.js";

const finalization = (cursors: CursorsState) =>
  [...cursors.accepted].reverse().find((submission) => submission.stepId === "R7.finalize");

const latestBatchByUpdatedAt = (batches: readonly BallotBatch[]): BallotBatch | null => {
  if (batches.length === 0) return null;
  return [...batches].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1) ?? null;
};

const STEP_STAGE: Readonly<Record<WorkflowStepId, string>> = {
  "R1.join": "Join",
  "R2.plan": "Plan",
  "R3.review": "Review",
  "R3.plan-ballot": "Plan ballot",
  "R4.implement": "Implement",
  "R4.amend-ballot": "Amendment ballot",
  "R5.compare": "Compare",
  "R5.compare-ballot": "Comparison ballot",
  "R6.revise": "Revise",
  "R6.ballot": "Revision ballot",
  "R7.finalize": "Finalize"
};

/** Readable stage label, then the diagnostic step id from describeWorkflowStep. */
export const describeActiveStep = (stepId: WorkflowStepId | null, round: number | null): string => {
  if (stepId === null) return "complete";
  const stage = STEP_STAGE[stepId] ?? stepId;
  const diagnostic = describeWorkflowStep(stepId, round);
  return `${stage} (${diagnostic})`;
};

const deliveryLabel = (delivery: string | undefined): string => {
  if (delivery === "ordered") return "task file published; not yet sent";
  if (delivery === "injected") return "task message sent; waiting for acknowledgment";
  if (delivery === "accepted") return "agent acknowledged the task";
  return "no action";
};

const prPolicyLabel = (policy: StartState["prPolicy"]): string => {
  if (policy === "coord-merged") {
    return "Pull request handling: coordinator opens a draft; you review and merge (coord-merged: coordinator merges)";
  }
  if (policy === "owner-only") {
    return "Pull request handling: coordinator opens a draft; you review and merge (legacy owner-only)";
  }
  return "Pull request handling: coordinator opens a draft; you review and merge";
};

const retryOwnerLabel = (owner: "owner" | "vendor"): string =>
  owner === "vendor" ? "waiting for the agent application's own retry" : "your action is required";

const holdReasonLabel = (reason: CursorsState["holds"][number]["reason"], sends: number): string => {
  if (reason === "nudge-loop") return `automatic reminder limit reached (${Math.min(sends, 4)}/4)`;
  if (reason === "delivery-uncertain") return "delivery may have been interrupted; inspect the agent terminal";
  if (reason === "harness-gone") return "agent harness pane is gone";
  if (reason === "unobservable") return "coordinator cannot yet confirm readiness";
  if (reason === "vendor-wait") return "agent application reported a temporary wait";
  if (reason === "vendor-failure") return "agent application reported a failure";
  return reason;
};

/** Shared human-readable hold body used by status and immediate hold logs. */
export const describeHold = (
  hold: CursorsState["holds"][number],
  sends: number
): string => {
  const parts: string[] = [
    holdReasonLabel(hold.reason, sends),
    `retry: ${retryOwnerLabel(hold.retryOwner)}`,
    `sends ${sends}/4`
  ];
  const evidence = hold.evidence ?? null;
  if (evidence !== null) {
    parts.unshift(`cause ${evidence.failureClass} (${evidence.vendor}, ${evidence.classConfidence})`);
  }
  if (hold.resetsAt !== null) {
    parts.push(`provider reset ${hold.resetsAt} (recheck time, not guaranteed availability)`);
  }
  return parts.join("; ");
};

export type ReportSeverity = "OK" | "WAIT" | "WARN" | "ACTION";

const reportSeverity = (
  cursors: CursorsState,
  lifecycle: AgentLifecycleState | undefined,
  start: StartState
): ReportSeverity => {
  if (cursors.abandoned) return "OK";
  if (cursors.completed && cursors.holds.length === 0) return "OK";
  if (cursors.ownerQuestion !== null) return "ACTION";
  if (cursors.holds.some((hold) => hold.retryOwner === "owner")) return "ACTION";
  if (cursors.manualPaused) return "ACTION";
  if (lifecycle !== undefined) {
    for (const agent of start.agents) {
      const entry = lifecycle.agents[agent.id];
      if (entry === undefined) continue;
      const coverage = containmentCoverage(entry, containmentPolicy(agent.root, agent.id)?.binding ?? null);
      if (coverage.hook === "unverified" || coverage.shim === "unverified") return "WARN";
      if (stopObservationWarning(entry, agent.id) !== null) return "WARN";
    }
  }
  if (cursors.paused || !cursors.completed) return "WAIT";
  return "OK";
};

/** One scoped recovery command, shared by immediate hold logs and status. */
export const holdRecoveryCommand = (
  issue: number,
  cursors: CursorsState,
  hold: CursorsState["holds"][number],
  coordRoot?: string
): string => {
  const uniqueAgent = cursors.activeRoster.includes(hold.agent) &&
    cursors.holds.filter((entry) => entry.agent === hold.agent).length === 1;
  const root = coordRoot === undefined || coordRoot === ""
    ? ""
    : ` --coord-root ${shellQuote(coordRoot)}`;
  return `coord resume --issue ${issue} ` +
    (uniqueAgent ? `--agent ${hold.agent}` : `--hold ${hold.id}`) +
    (hold.reason === "nudge-loop" ? " --reset-nudge-budget" : "") +
    root;
};

export type RenderIssueReportOptions = {
  /** When omitted, Active step/roster/guidance are still rendered from cursors. */
  includeGuidance?: boolean;
};

/**
 * What the owner needs after a run: who won, which commit is the PR head,
 * which branch coord pushed, evidence publication state, and whether they
 * still have to merge. Never exposes ballot choices, dispositions, rationales,
 * or pending response bytes.
 */
export const renderIssueReport = (
  start: StartState,
  cursors: CursorsState,
  lifecycle?: AgentLifecycleState,
  _options?: RenderIssueReportOptions // reserved for callers that previously appended guidance outside the frame
): string => {
  void _options;
  const r7 = finalization(cursors);
  const acceptedImplementation = cursors.accepted
    .filter(
      (submission) =>
        submission.stepId === "R4.implement" && cursors.activeRoster.includes(submission.agent)
    )
    .at(-1);
  const pin = cursors.publication.finalSha ?? r7?.productPin ?? null;
  const chosen =
    cursors.derived.implementationSelection?.winner ?? acceptedImplementation?.agent ?? r7?.agent;
  const implementationPin =
    cursors.derived.implementationSelection?.implementationPin ??
    acceptedImplementation?.productPin ??
    r7?.productPin ??
    null;
  const branch = cursors.publication.branch;
  const url = cursors.publication.url;
  const phase = cursors.abandoned
    ? "abandoned"
    : cursors.paused
      ? "paused"
      : cursors.completed
        ? "complete"
        : (cursors.issueCursor.stepId ?? "running");
  const severity = reportSeverity(cursors, lifecycle, start);
  const lines = [
    `----`,
    `[${severity}] Issue ${start.issue}: ${phase}`,
    prPolicyLabel(start.prPolicy),
    `Chosen agent: ${chosen ?? "(not selected yet)"}`,
    `Implementation commit: ${implementationPin ?? "(none)"}`,
    `Final commit (PR head): ${pin ?? "(none)"}`,
    `Published branch: ${branch ?? "(not pushed yet)"}`,
    `Active step: ${describeActiveStep(cursors.issueCursor.stepId, cursors.issueCursor.round)}`,
    `Active roster: ${cursors.activeRoster.join(", ") || "(none)"}`,
    `Queued guidance: ${cursors.ownerGuidance?.pending.length ?? 0}`
  ];
  if (cursors.manualPaused) {
    lines.push(
      `Manual pause: active (coord resume --issue ${start.issue}` +
        (start.coordRoot ? ` --coord-root ${shellQuote(start.coordRoot)}` : "") +
        ` clears only this pause).`
    );
  }
  for (const hold of cursors.holds) {
    const sends = cursors.actionSafety[hold.agent]?.sends ?? 0;
    const evidence = hold.evidence ?? null;
    lines.push(`Hold ${hold.id}: ${hold.agent}; ${describeHold(hold, sends)}.`);
    if (evidence !== null && evidence.windows.length > 0) {
      lines.push(`Blocked windows: ${evidence.windows.map((window) =>
        `${window.limitId}/${window.window} ${window.usedPercent ?? "?"}% (resets ${window.resetsAt ?? "unknown"})`).join("; ")}.`);
    }
    if (evidence?.detail !== null && evidence?.detail !== undefined) {
      lines.push(`Vendor detail (redacted): ${evidence.detail}`);
    }
    lines.push(
      `Recovery: inspect the agent, then ${holdRecoveryCommand(start.issue, cursors, hold, start.coordRoot)}` +
        ` (--run only if the coordinator was stopped).`
    );
  }
  if (cursors.paused) {
    lines.push(
      "The running coordinator waits and continues after all pauses are released; add --run to resume only if the coordinator was stopped."
    );
  }
  for (const agent of new Set(cursors.holds.map((hold) => hold.agent))) {
    const safety = cursors.actionSafety[agent];
    const resource = safety?.resource;
    if (resource === undefined || (resource.starts === 0 && resource.nextAt === null && resource.terminal === null)) continue;
    if (resource.terminal !== null) {
      lines.push(`Resource observation (${agent}): stopped (${resource.terminal}); owner release required.`);
      if (resource.terminal.includes("reaped")) {
        lines.push(`Before any further quota read, confirm no codex app-server is running for the bound home, then remove its record under ${start.coordRoot}/resource-bindings/.`);
      }
    } else if (resource.nextAt !== null) {
      lines.push(`Resource observation (${agent}): next automatic check at ${resource.nextAt}; quota reads ${resource.starts}/6.`);
    } else {
      lines.push(`Resource observation (${agent}): none scheduled; owner release required. Quota reads ${resource.starts}/6.`);
    }
  }
  if (url !== null) lines.push(`Pull request: ${url}`);
  else if (pin !== null && cursors.publication.status === "not-required") {
    lines.push(
      `Pull request: none (legacy owner-only). Open a PR from the final commit, not from issue-${start.issue}/<agent>.`
    );
  } else if (cursors.publication.status === "failed") {
    lines.push(`Pull request: not opened (${cursors.publication.error ?? "publication failed"})`);
  } else if (cursors.completed) {
    lines.push("Pull request: pending publication");
  }
  if (cursors.publication.status === "completed" && url !== null) {
    lines.push(
      coordMergesPullRequest(start.prPolicy)
        ? "Merge: coordinator merged this PR."
        : "Merge: owner merges this PR (draft until you mark it ready)."
    );
  } else if (cursors.publication.status === "failed" && url !== null && coordMergesPullRequest(start.prPolicy)) {
    lines.push(`Merge: coordinator merge failed (${cursors.publication.error}). Merge at the URL above.`);
  }
  if (cursors.publication.error !== null && cursors.publication.status === "failed") {
    lines.push(`Error: ${cursors.publication.error}`);
  }

  const evidenceBranch = cursors.evidence.branch;
  const evidenceTip = cursors.evidence.tip;
  if (evidenceBranch !== null) {
    lines.push(
      `Evidence branch: ${evidenceBranch}` +
        (evidenceTip !== null ? ` (latest published tip ${evidenceTip})` : " (no published tip yet)")
    );
  } else {
    lines.push("Evidence branch: (none yet)");
  }

  const pending = cursors.ballotBatches.filter((batch) => batch.status === "pending");
  const failed = cursors.ballotBatches.filter((batch) => batch.status === "failed");
  const pendingLatest = latestBatchByUpdatedAt(pending);
  const failedLatest = latestBatchByUpdatedAt(failed);
  if (pendingLatest !== null) {
    lines.push(
      `Evidence publication: pending (${pendingLatest.kind}` +
        (pendingLatest.round === null ? "" : ` round ${pendingLatest.round}`) +
        `, commit ${pendingLatest.commitSha})`
    );
  } else if (failedLatest !== null) {
    lines.push(
      `Evidence publication: failed (${failedLatest.kind}` +
        (failedLatest.round === null ? "" : ` round ${failedLatest.round}`) +
        `${failedLatest.error === null ? "" : `: ${failedLatest.error}`})`
    );
  } else if (cursors.ballotBatches.some((batch) => batch.status === "published")) {
    lines.push("Evidence publication: published");
  }

  if (lifecycle !== undefined) {
    for (const agent of start.agents) {
      const entry = lifecycle.agents[agent.id];
      if (entry === undefined) continue;
      const queue = entry.pendingInputCount === null ? "" : `, pending=${entry.pendingInputCount}`;
      const background = entry.backgroundActive === true ? ", background-active" : "";
      const alert = entry.degradedCause === null ? "" : `, alert=${entry.degradedCause}`;
      const coverage = containmentCoverage(entry, containmentPolicy(agent.root, agent.id)?.binding ?? null);
      const probe = entry.containment?.probe;
      const stopWarn = stopObservationWarning(entry, agent.id);
      lines.push(
        `Agent ${agent.id}: ${deliveryLabel(entry.action?.delivery)} / ${entry.execution} / ${entry.health}${queue}${background}${alert}` +
        `, containment hook=${coverage.hook} shim=${coverage.shim}` +
        (entry.sessionId === null ? " (session identity unavailable)" : "") +
        (probe ? ` (agent-observed ${probe.at}, session=${probe.sessionId}, vendor=${probe.vendorVersion}, policy=${probe.policyRevision})` : "")
      );
      if (stopWarn !== null) lines.push(stopWarn);
    }
  }
  lines.push(`----`);
  return `${lines.join("\n")}\n`;
};
