import type { CursorsState, StartState } from "./state.js";
import type { AgentLifecycleState } from "./agentLifecycle.js";
import { coordMergesPullRequest } from "./steps.js";

const finalization = (cursors: CursorsState) =>
  [...cursors.accepted].reverse().find((submission) => submission.stepId === "R7.finalize");

/**
 * What the owner needs after a run: who won, which commit is the PR head,
 * which branch coord pushed, and whether they still have to merge.
 */
export const renderIssueReport = (
  start: StartState,
  cursors: CursorsState,
  lifecycle?: AgentLifecycleState
): string => {
  const r7 = finalization(cursors);
  const pin = cursors.publication.finalSha ?? r7?.productPin ?? null;
  // Consensus runs name the winner in the canonical decision. Reviewed and solo
  // runs never hold that election, so the sole accepted implementation — or,
  // failing that, whoever finalized — is the honest answer.
  const implementationSelection = cursors.derived.implementationSelection;
  const soleImplementation = cursors.accepted.filter((submission) => submission.stepId === "R4.implement");
  const chosen =
    implementationSelection?.implementationAgent ??
    (soleImplementation.length === 1 ? soleImplementation[0]?.agent : undefined) ??
    r7?.agent;
  const implementationPin =
    implementationSelection?.implementationPin ??
    (soleImplementation.length === 1 ? soleImplementation[0]?.productPin : undefined) ??
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
  if (lifecycle !== undefined) {
    for (const agent of start.agents) {
      const entry = lifecycle.agents[agent.id];
      if (entry === undefined) continue;
      const queue = entry.pendingInputCount === null ? "" : `, pending=${entry.pendingInputCount}`;
      const background = entry.backgroundActive === true ? ", background-active" : "";
      // Naming the cause is the difference between "restart this CLI" and
      // "this agent is still finishing its previous turn".
      const alert = entry.degradedCause === null ? "" : `, alert=${entry.degradedCause}`;
      lines.push(
        `Agent ${agent.id}: ${entry.action?.delivery ?? "none"} / ${entry.execution} / ${entry.health}${queue}${background}${alert}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
};
