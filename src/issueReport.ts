import type { BallotBatch, CursorsState, StartState } from "./state.js";
import { coordMergesPullRequest, describeWorkflowStep } from "./steps.js";
import { containmentCoverage } from "./agentLifecycle.js";
import { containmentPolicy } from "./shellGuard.js";
import { shellQuote } from "./agentHookSync.js";

const finalization = (cursors: CursorsState) =>
  [...cursors.accepted].reverse().find((submission) => submission.stepId === "R7.finalize");

const latestBatchByUpdatedAt = (batches: readonly BallotBatch[]): BallotBatch | null => {
  if (batches.length === 0) return null;
  return [...batches].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1) ?? null;
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
  const rootArg = coordRoot !== undefined && coordRoot !== "" ? ` --coord-root ${shellQuote(coordRoot)}` : "";
  return `coord resume --issue ${issue} ` +
    (uniqueAgent ? `--agent ${hold.agent}` : `--hold ${hold.id}`) +
    (hold.reason === "nudge-loop" ? " --reset-nudge-budget" : "") +
    rootArg;
};

export type IssueReportExtra = {
  stepId?: string | null;
  round?: number | null;
  activeRoster?: readonly string[];
  guidanceCount?: number;
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
  lifecycle?: import("./agentLifecycle.js").AgentLifecycleState,
  extra?: IssueReportExtra
): string => {
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

  const statusIndicator =
    cursors.abandoned || cursors.holds.length > 0 || cursors.manualPaused
      ? "⚠"
      : "✓";
  const statusText =
    cursors.abandoned || cursors.holds.length > 0 || cursors.manualPaused
      ? "intervention needed"
      : "progressing";

  const policyDescription = start.prPolicy === "coord-merged"
    ? "Policy: coord-merged (coordinator merged)"
    : start.prPolicy === "coord-open-unmerged"
      ? "Policy: coord-open-unmerged (owner merges)"
      : `Policy: ${start.prPolicy} (legacy owner-only)`;

  const lines = [
    `Issue ${start.issue}: ${phase}`,
    `Status: ${statusIndicator} ${statusText}`,
    policyDescription,
    `Chosen agent: ${chosen ?? "(not selected yet)"}`,
    `Implementation commit (pin): ${implementationPin ?? "(none)"}`,
    `Final pin (PR head): ${pin ?? "(none)"}`,
    `Published branch: ${branch ?? "(not pushed yet)"}`
  ];

  if (cursors.manualPaused) lines.push(`⚠ Manual pause: active (coord resume --issue ${start.issue} clears only this pause).`);
  for (const hold of cursors.holds) {
    const sends = cursors.actionSafety[hold.agent]?.sends ?? 0;
    const evidence = hold.evidence ?? null;
    const cause = evidence === null ? "cause unknown" : `cause ${evidence.failureClass} (${evidence.vendor}, ${evidence.classConfidence})`;
    // An exact provider epoch is when to recheck, never a promise of availability.
    const reset = hold.resetsAt === null ? "reset unknown" : `provider reset ${hold.resetsAt} (recheck time, not guaranteed availability)`;
    const holdReasonText = hold.reason === "nudge-loop"
      ? "nudge-loop (automatic reminder limit reached, 4/4)"
      : hold.reason;

    lines.push(`Hold ${hold.id}: ${hold.agent}, ${holdReasonText}; ${cause}, ${reset}, retry owner: ${hold.retryOwner}; sends ${sends}/4.`);
    if (evidence !== null && evidence.windows.length > 0) {
      lines.push(`Blocked windows: ${evidence.windows.map((window) =>
        `${window.limitId}/${window.window} ${window.usedPercent ?? "?"}% (resets ${window.resetsAt ?? "unknown"})`).join("; ")}.`);
    }
    if (evidence?.detail !== null && evidence?.detail !== undefined) lines.push(`Vendor detail (redacted): ${evidence.detail}`);
    lines.push(`Recovery: inspect the agent, then ${holdRecoveryCommand(start.issue, cursors, hold, start.coordRoot)}`);
  }
  if (cursors.paused) {
    lines.push("The running coordinator waits and continues after all pauses are released; add --run to resume only if the coordinator was stopped.");
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
      `Pull request: none (legacy owner-only). Open a PR from the final commit (PR head), not from issue-${start.issue}/<agent>.`
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
      const delivery = entry.action?.delivery;
      const deliveryLabel = delivery === "ordered"
        ? "action issued"
        : delivery === "injected"
          ? "action delivered to pane"
          : delivery === "accepted"
            ? "action accepted"
            : "none";

      lines.push(
        `Agent ${agent.id}: ${deliveryLabel} / ${entry.execution} / ${entry.health}${queue}${background}${alert}` +
        `, containment hook=${coverage.hook} shim=${coverage.shim}` +
        (entry.sessionId === null ? " (session identity unavailable)" : "") +
        (probe ? ` (agent-observed ${probe.at}, session=${probe.sessionId}, vendor=${probe.vendorVersion}, policy=${probe.policyRevision})` : "")
      );
    }
  }

  if (extra !== undefined) {
    if (extra.stepId !== undefined && extra.stepId !== null) {
      lines.push(`Active step: ${describeWorkflowStep(extra.stepId as import("./steps.js").WorkflowStepId, extra.round ?? null)}`);
    }
    if (extra.activeRoster !== undefined) {
      lines.push(`Active roster: ${extra.activeRoster.join(", ")}`);
    }
    if (extra.guidanceCount !== undefined) {
      lines.push(`Queued guidance: ${extra.guidanceCount}`);
    }
  }

  lines.push("----");
  return `${lines.join("\n")}\n`;
};
