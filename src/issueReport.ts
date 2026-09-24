import type { BallotBatch, CursorsState, StartState } from "./state.js";
import { coordMergesPullRequest } from "./steps.js";

const finalization = (cursors: CursorsState) =>
  [...cursors.accepted].reverse().find((submission) => submission.stepId === "R7.finalize");

const latestBatchByUpdatedAt = (batches: readonly BallotBatch[]): BallotBatch | null => {
  if (batches.length === 0) return null;
  return [...batches].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1) ?? null;
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
  lifecycle?: import("./agentLifecycle.js").AgentLifecycleState
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
  const lines = [
    `Issue ${start.issue}: ${phase}`,
    `Policy: ${start.prPolicy}`,
    `Chosen agent: ${chosen ?? "(not selected yet)"}`,
    `Implementation pin: ${implementationPin ?? "(none)"}`,
    `Final pin (PR head): ${pin ?? "(none)"}`,
    `Published branch: ${branch ?? "(not pushed yet)"}`
  ];
  if (cursors.manualPaused) lines.push("Manual pause: active (plain coord resume clears only this pause).");
  for (const hold of cursors.holds) {
    const sends = cursors.actionSafety[hold.agent]?.sends ?? 0;
    const probe = cursors.actionSafety[hold.agent]?.probe;
    const windows =
      (hold.windows?.length ?? 0) === 0
        ? ""
        : `; windows ${hold.windows.map((w) => `${w.bucket}${w.usedPercent === null ? "" : `@${w.usedPercent}%`}`).join(",")}`;
    const budget =
      probe === undefined
        ? ""
        : `; observation starts ${probe.starts}/6${probe.exhausted ? " exhausted" : ""}`;
    const detail = hold.detail === null || hold.detail === undefined || hold.detail === "" ? "" : `; detail ${hold.detail}`;
    const failureClass = hold.failureClass ?? "unknown";
    const confidence = hold.confidence ?? "unknown";
    const cause =
      failureClass === "unknown" && confidence === "unknown"
        ? "cause unknown"
        : `cause ${failureClass} (${confidence})`;
    const reset =
      hold.resetsAt === null || hold.resetsAt === undefined
        ? "reset unknown"
        : `exact reset ${hold.resetsAt} (recheck ≠ guaranteed availability)`;
    lines.push(
      `Hold ${hold.id}: ${hold.agent}, ${hold.reason}; ${cause}, ${reset}, retry owner: ${hold.retryOwner}; sends ${sends}/4${windows}${budget}${detail}.`
    );
    if (hold.recovery?.outcome === "pending" && hold.recovery.nextAt !== null) {
      lines.push(`Automatic recheck at ${hold.recovery.nextAt} (does not guarantee capacity).`);
    } else {
      lines.push(
        `Recovery: inspect the agent, then coord resume --issue ${start.issue} --hold ${hold.id}` +
          (hold.reason === "nudge-loop" ? " --reset-nudge-budget" : "") +
          (hold.recovery?.outcome === "owner" || hold.resetsAt === null ? "; owner release required" : "")
      );
    }
  }
  if (url !== null) lines.push(`Pull request: ${url}`);
  else if (pin !== null && cursors.publication.status === "not-required") {
    lines.push(
      `Pull request: none (legacy owner-only). Open a PR from the final pin, not from issue-${start.issue}/<agent>.`
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
      lines.push(
        `Agent ${agent.id}: ${entry.action?.delivery ?? "none"} / ${entry.execution} / ${entry.health}${queue}${background}${alert}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
};
