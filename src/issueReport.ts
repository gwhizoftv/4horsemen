import type { BallotBatch, CursorsState, StartState } from "./state.js";
import { coordMergesPullRequest, describeWorkflowStep, type WorkflowStepId } from "./steps.js";
import { containmentCoverage, stopHookWarning, type AgentLifecycleEntry } from "./agentLifecycle.js";
import { shellQuote } from "./agentHookSync.js";
import { containmentPolicy } from "./shellGuard.js";

/**
 * Owner-facing vocabulary. Persisted enums, journal codes and workflow IDs stay
 * unchanged; they appear here only in parentheses after a plain description.
 * An **action** is the task coord writes to an agent's `action.md`; a **turn**
 * is one observed prompt/response cycle in the agent's terminal.
 */
export type Severity = "[OK]" | "[WAIT]" | "[WARN]" | "[ACTION]";

const STAGE_NAMES: Readonly<Record<WorkflowStepId, string>> = {
  "R1.join": "agents joining",
  "R2.plan": "writing plans",
  "R3.review": "reviewing plans",
  "R3.plan-ballot": "voting on plans",
  "R4.implement": "implementing",
  "R4.amend-ballot": "voting on a file-map amendment",
  "R5.compare": "comparing implementations",
  "R5.compare-ballot": "voting on implementations",
  "R6.revise": "revising the chosen implementation",
  "R6.ballot": "voting on the revision",
  "R7.finalize": "finalizing the pull request commit"
};

/** A readable stage name before the diagnostic step ID. */
export const describeStage = (stepId: WorkflowStepId | null, round: number | null): string =>
  stepId === null ? "complete" : `${STAGE_NAMES[stepId]} (${describeWorkflowStep(stepId, round)})`;

/** Every printed owner command names its runtime, so it works from any folder. */
export const ownerCommand = (start: Pick<StartState, "coordRoot">, command: string): string =>
  `${command} --coord-root ${shellQuote(start.coordRoot)}`;

const finalization = (cursors: CursorsState) =>
  [...cursors.accepted].reverse().find((submission) => submission.stepId === "R7.finalize");

const latestBatchByUpdatedAt = (batches: readonly BallotBatch[]): BallotBatch | null => {
  if (batches.length === 0) return null;
  return [...batches].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1) ?? null;
};

type Hold = CursorsState["holds"][number];

/** One scoped recovery command, shared by immediate hold logs and status. */
export const holdRecoveryCommand = (
  start: Pick<StartState, "issue" | "coordRoot">, cursors: CursorsState, hold: Hold
): string => {
  const uniqueAgent = cursors.activeRoster.includes(hold.agent) &&
    cursors.holds.filter((entry) => entry.agent === hold.agent).length === 1;
  return ownerCommand(start, `coord resume --issue ${start.issue} ` +
    (uniqueAgent ? `--agent ${hold.agent}` : `--hold ${hold.id}`) +
    (hold.reason === "nudge-loop" ? " --reset-nudge-budget" : ""));
};

const HOLD_REASONS: Readonly<Record<Hold["reason"], string>> = {
  "nudge-loop": "automatic reminder limit reached: coord sent this action 4 times and the agent has not finished it",
  "delivery-uncertain": "a send into the agent's terminal was interrupted, so coord cannot tell whether the agent received its action",
  "harness-gone": "the agent's terminal pane closed or its program exited",
  unobservable: "an older coordinator could not observe the agent's terminal",
  "vendor-wait": "the agent application is waiting out a usage limit",
  "vendor-failure": "the agent application reported a failure"
};

/**
 * Plain-language hold explanation: what stopped, who acts next, and the exact
 * release command. A provider recheck time is never presented as a promise,
 * and the local reminder allowance is distinct from any provider limit.
 */
export const describeHold = (start: Pick<StartState, "issue" | "coordRoot">, cursors: CursorsState, hold: Hold): string[] => {
  const sends = cursors.actionSafety[hold.agent]?.sends ?? 0;
  const evidence = hold.evidence ?? null;
  const lines = [`Hold ${hold.id}: ${hold.agent} — ${HOLD_REASONS[hold.reason]} (${hold.reason}; sends ${sends}/4).`];
  if (evidence !== null) {
    lines.push(`Cause: ${evidence.failureClass} reported by ${evidence.vendor} (${evidence.classConfidence}).`);
    if (evidence.windows.length > 0) {
      lines.push(`Blocked windows: ${evidence.windows.map((window) =>
        `${window.limitId}/${window.window} ${window.usedPercent ?? "?"}% (resets ${window.resetsAt ?? "unknown"})`).join("; ")}.`);
    }
    if (evidence.detail !== null) lines.push(`Vendor detail (redacted): ${evidence.detail}`);
  }
  // An exact provider epoch is when to recheck, never a promise of availability.
  if (hold.resetsAt !== null) {
    lines.push(`Provider recheck time: ${hold.resetsAt} (when coord looks again; not a promise the limit has lifted, and you cannot reset a provider limit).`);
  }
  lines.push(hold.retryOwner === "vendor"
    ? "Who acts next: the agent application retries by itself; wait for it."
    : "Who acts next: you.");
  const release = hold.reason === "nudge-loop"
    ? "then allow it 4 more automatic sends (press r in the coord terminal, or run"
    : "then release this hold (press r in the coord terminal, or run";
  lines.push(`To fix: look at ${hold.agent}'s terminal (coord attach ${start.issue}) and fix what is wrong, ${release}: ` +
    `${holdRecoveryCommand(start, cursors, hold)}).`);
  return lines;
};

const DELIVERY_LABELS: Readonly<Record<"ordered" | "injected" | "accepted", string>> = {
  ordered: "action.md published; not yet sent to the agent",
  injected: "action sent; waiting for the agent to acknowledge it",
  accepted: "agent acknowledged the action"
};
const EXECUTION_LABELS: Readonly<Record<AgentLifecycleEntry["execution"], string>> = {
  unknown: "no turn reported by its hooks yet",
  queued: "input queued in its terminal",
  working: "mid-turn",
  idle: "between turns",
  failed: "last turn failed"
};
const WORK_LABELS: Readonly<Partial<Record<CursorsState["agents"][string]["status"], string>>> = {
  idle: "nothing assigned",
  ordered: "working on its action",
  intent: "submitted; coord is checking it",
  verifying: "submitted; coord is checking it",
  "waiting-peer": "submission accepted; waiting for other agents"
};

const agentLines = (
  start: StartState, cursors: CursorsState, lifecycle: import("./agentLifecycle.js").AgentLifecycleState
): string[] => {
  const lines: string[] = [];
  for (const agent of start.agents) {
    const entry = lifecycle.agents[agent.id];
    if (entry === undefined) continue;
    const queue = entry.pendingInputCount === null ? "" : `, pending=${entry.pendingInputCount}`;
    const background = entry.backgroundActive === true ? ", background-active" : "";
    const alert = entry.degradedCause === null ? "" : `, alert=${entry.degradedCause}`;
    const coverage = containmentCoverage(entry, containmentPolicy(agent.root, agent.id)?.binding ?? null);
    const probe = entry.containment?.probe;
    const warning = stopHookWarning(agent.id, start.issue, entry);
    const status = cursors.agents[agent.id]?.status;
    const work = status === undefined ? "" : `${WORK_LABELS[status] ?? status}; `;
    // Unknown hook coverage is never reported as OK.
    const severity: Severity = warning !== null || coverage.hook === "inactive" || entry.health === "degraded" ? "[WARN]"
      : coverage.hook === "active" && entry.sessionId !== null ? "[OK]" : "[WAIT]";
    lines.push(
      `${severity} Agent ${agent.id}: ${work}${entry.action === null ? "no action yet" : DELIVERY_LABELS[entry.action.delivery]}; ` +
        `${EXECUTION_LABELS[entry.execution]}; hooks ${entry.health}${queue}${background}${alert}` +
        `; git guard hook=${coverage.hook} shim=${coverage.shim}` +
        (entry.sessionId === null ? " (no hook has reported from this agent's session yet)" : "") +
        (probe ? ` (agent-observed ${probe.at}, session=${probe.sessionId}, vendor=${probe.vendorVersion}, policy=${probe.policyRevision})` : "")
    );
    if (warning !== null) lines.push(`  Warning: ${warning}`);
  }
  return lines;
};

const pullRequestHandling = (start: StartState): string =>
  coordMergesPullRequest(start.prPolicy)
    ? `Pull request handling: coord opens and merges the pull request (policy ${start.prPolicy}).`
    : `Pull request handling: coord opens a draft pull request; you review and merge it (policy ${start.prPolicy}).`;

/**
 * The single owner snapshot for CLI status, the interactive `s` key and the
 * runner's paused/final reports, framed by `----` lines. It says whether the
 * owner must act, who won, which commit is the PR head, which branch coord
 * pushed, evidence publication state, and whether the owner still has to merge.
 * Never exposes ballot choices, dispositions, rationales, or pending response bytes.
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
  const stage = describeStage(cursors.issueCursor.stepId, cursors.issueCursor.round);
  const resume = ownerCommand(start, `coord resume --issue ${start.issue}`);
  const publicationFailed = cursors.publication.status === "failed";
  const [severity, phase, next]: [Severity, string, string] = cursors.abandoned
    ? ["[WARN]", "abandoned", "nothing; the workflow was abandoned and its state was kept."]
    : cursors.completed && !publicationFailed
      ? ["[OK]", "complete", "nothing for coord; see the pull request below."]
      : cursors.ownerQuestion !== null
        ? ["[ACTION]", stage, "answer the owner question shown in the coord terminal."]
        : cursors.holds.length > 0
          ? ["[ACTION]", `paused — ${stage}`, "inspect each held agent below, then release its hold."]
          : cursors.manualPaused
            ? ["[ACTION]", `paused — ${stage}`, `resume when ready (press p in the coord terminal, or run ${resume}).`]
            : publicationFailed
              ? ["[ACTION]", cursors.completed ? "complete" : stage, "the pull request could not be published; see the error below."]
              : ["[WAIT]", stage, "nothing; agents are working and coord continues by itself."];
  const lines = [
    "----",
    `${severity} Issue ${start.issue}: ${phase}`,
    `Next for you: ${next}`,
    `Active agents: ${cursors.activeRoster.join(", ")}`,
    `Queued owner guidance (/steer): ${cursors.ownerGuidance?.pending.length ?? 0}`,
    pullRequestHandling(start),
    `Chosen agent: ${chosen ?? "(not selected yet)"}`,
    `Implementation commit: ${implementationPin ?? "(none yet)"}`,
    `Final commit (PR head): ${pin ?? "(none yet)"}`,
    `Published branch: ${branch ?? "(not pushed yet)"}`
  ];
  if (cursors.manualPaused) lines.push(`Manual pause: on (${resume} clears only this pause).`);
  for (const hold of cursors.holds) lines.push(...describeHold(start, cursors, hold));
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
      `Pull request: none (legacy owner-only). Open a PR from the final commit, not from issue-${start.issue}/<agent>.`
    );
  } else if (publicationFailed) {
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
  } else if (publicationFailed && url !== null && coordMergesPullRequest(start.prPolicy)) {
    lines.push(`Merge: coordinator merge failed (${cursors.publication.error}). Merge at the URL above.`);
  }
  if (cursors.publication.error !== null && publicationFailed) {
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

  if (lifecycle !== undefined) lines.push(...agentLines(start, cursors, lifecycle));
  lines.push("----");
  return `${lines.join("\n")}\n`;
};
